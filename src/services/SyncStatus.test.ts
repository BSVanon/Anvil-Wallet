import {
  isRegisterFailureError,
  displayForStatus,
  readSyncStatus,
  writeSyncStatus,
} from './SyncStatus.service';

describe('isRegisterFailureError', () => {
  it('matches the exact spv-store message', () => {
    expect(isRegisterFailureError(new Error('Failed to register account'))).toBe(true);
  });

  it('matches with wrapping or prefix text', () => {
    expect(
      isRegisterFailureError(
        new Error('Uncaught (in promise) Error: Failed to register account'),
      ),
    ).toBe(true);
  });

  it('is case insensitive', () => {
    expect(isRegisterFailureError(new Error('FAILED TO REGISTER ACCOUNT'))).toBe(true);
  });

  it('matches plain string errors too', () => {
    expect(isRegisterFailureError('Failed to register account')).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isRegisterFailureError(new Error('TypeError: localStorage is not defined'))).toBe(
      false,
    );
    expect(isRegisterFailureError(new Error('Network timeout'))).toBe(false);
    expect(isRegisterFailureError(new Error('HTTP 503'))).toBe(false);
  });

  it('safe on null / undefined / non-error inputs', () => {
    expect(isRegisterFailureError(null)).toBe(false);
    expect(isRegisterFailureError(undefined)).toBe(false);
    expect(isRegisterFailureError(123)).toBe(false);
    expect(isRegisterFailureError({})).toBe(false);
  });
});

describe('displayForStatus', () => {
  it('healthy → banner hidden', () => {
    const d = displayForStatus('healthy');
    expect(d.show).toBe(false);
    expect(d.showRetry).toBe(false);
  });

  it('initializing → blue banner, no retry', () => {
    const d = displayForStatus('initializing');
    expect(d.show).toBe(true);
    expect(d.color).toBe('blue');
    expect(d.showRetry).toBe(false);
    expect(d.title).toMatch(/syncing/i);
  });

  it('retrying → blue banner, no retry button (disabled while in-flight)', () => {
    const d = displayForStatus('retrying');
    expect(d.show).toBe(true);
    expect(d.color).toBe('blue');
    expect(d.showRetry).toBe(false);
  });

  it('degraded → red banner, retry visible, honest subtitle', () => {
    const d = displayForStatus('degraded');
    expect(d.show).toBe(true);
    expect(d.color).toBe('red');
    expect(d.showRetry).toBe(true);
    expect(d.subtitle).toMatch(/hidden|fallback|degraded/i);
  });

  it('title differs between initializing and degraded (honest signal)', () => {
    const init = displayForStatus('initializing');
    const degr = displayForStatus('degraded');
    expect(init.title).not.toBe(degr.title);
    expect(init.color).not.toBe(degr.color);
  });
});

describe('read/writeSyncStatus', () => {
  // Mock chrome.storage.session for the Jest env (jsdom does not
  // provide the chrome extension APIs).
  beforeEach(() => {
    const store: Record<string, unknown> = {};
    (global as any).chrome = { // eslint-disable-line @typescript-eslint/no-explicit-any
      storage: {
        session: {
          get: jest.fn(async (key: string) =>
            key in store ? { [key]: store[key] } : {},
          ),
          set: jest.fn(async (obj: Record<string, unknown>) => {
            Object.assign(store, obj);
          }),
        },
        onChanged: {
          addListener: jest.fn(),
          removeListener: jest.fn(),
        },
      },
    };
  });

  afterEach(() => {
    delete (global as any).chrome; // eslint-disable-line @typescript-eslint/no-explicit-any
  });

  it('read returns initializing when key is unset', async () => {
    expect(await readSyncStatus()).toBe('initializing');
  });

  it('write then read round-trips', async () => {
    await writeSyncStatus('degraded');
    expect(await readSyncStatus()).toBe('degraded');
  });

  it('read returns default when chrome.storage is unavailable', async () => {
    delete (global as any).chrome; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(await readSyncStatus()).toBe('initializing');
  });

  it('write is no-op when chrome.storage is unavailable (does not throw)', async () => {
    delete (global as any).chrome; // eslint-disable-line @typescript-eslint/no-explicit-any
    await expect(writeSyncStatus('healthy')).resolves.toBeUndefined();
  });
});
