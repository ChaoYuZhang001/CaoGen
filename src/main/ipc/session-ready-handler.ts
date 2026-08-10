import { sessionManager } from '../sessionManager'

export function sessionReadyHandler<TArgs extends unknown[], TResult>(
  handler: (...args: TArgs) => TResult | Promise<TResult>
) {
  return async (...args: TArgs) => {
    await sessionManager.whenInitialized()
    return handler(...args)
  }
}
