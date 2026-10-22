/*
 * Run async work one call at a time.
 *
 * WebCrypto is asynchronous, so a state machine whose method awaits it can be
 * entered a second time before the first call has finished — two `apply()`s
 * that both see the same head merge a fork; two `read()`s that both see the
 * same next seq accept one record twice. Everything stateful in this directory
 * puts its methods through one of these, which is what the synchronous Rust
 * half gets for free.
 */
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
