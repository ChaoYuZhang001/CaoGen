/**
 * 可外部推送的 AsyncIterable,用作 Agent SDK 流式输入通道:
 * 一个 query() 持有它,UI 侧随时 push 新的用户消息即可延续多轮对话。
 */
export class Pushable<T> implements AsyncIterable<T> {
  private queue: T[] = []
  private resolvers: Array<(r: IteratorResult<T>) => void> = []
  private done = false

  push(value: T): void {
    if (this.done) return
    const resolve = this.resolvers.shift()
    if (resolve) resolve({ value, done: false })
    else this.queue.push(value)
  }

  end(): void {
    if (this.done) return
    this.done = true
    for (const resolve of this.resolvers.splice(0)) {
      resolve({ value: undefined as never, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift() as T, done: false })
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as never, done: true })
        }
        return new Promise((resolve) => this.resolvers.push(resolve))
      }
    }
  }
}
