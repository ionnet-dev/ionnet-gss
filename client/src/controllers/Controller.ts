/**
 * Base for shared client state. Subclasses change their fields, then call `notify()`; components re-render through
 * `useController(controller)`.
 */
export class Controller {
  private _listeners = new Set<() => void>();
  private _version = 0;

  /**
   * Tell every subscribed component that this controller changed.
   */
  public notify(): void {
    this._version++;
    for (const listener of this._listeners) listener();
  }

  /**
   * For `useSyncExternalStore`. Returns the unsubscribe function.
   */
  public subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  };

  /**
   * Changes on every `notify()`; the snapshot `useController` compares.
   */
  public getVersion = (): number => this._version;
}

export default Controller;
