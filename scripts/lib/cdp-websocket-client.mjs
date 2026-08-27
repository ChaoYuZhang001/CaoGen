export function connectCdp(url, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const pending = new Map()
    let nextId = 1

    socket.addEventListener('message', (event) => {
      const data = JSON.parse(event.data)
      const request = data.id ? pending.get(data.id) : undefined
      if (!request) return
      pending.delete(data.id)
      clearTimeout(request.timeout)
      if (data.error) request.reject(new Error(data.error.message || JSON.stringify(data.error)))
      else request.resolve(data.result ?? {})
    })
    socket.addEventListener('open', () => resolve({
      send(method, params = {}) {
        const id = nextId++
        socket.send(JSON.stringify({ id, method, params }))
        return new Promise((resolveSend, rejectSend) => {
          const timeout = setTimeout(() => {
            if (!pending.delete(id)) return
            rejectSend(new Error(`CDP timeout: ${method}`))
          }, timeoutMs)
          pending.set(id, { resolve: resolveSend, reject: rejectSend, timeout })
        })
      },
      close() {
        socket.close()
      }
    }), { once: true })
    socket.addEventListener('error', () => reject(new Error('DevTools WebSocket connection failed')), { once: true })
  })
}
