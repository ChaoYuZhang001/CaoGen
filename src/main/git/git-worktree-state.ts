export function hasMeaningfulWorktreeChanges(output: string): boolean {
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    if (line.startsWith('? ') || line.startsWith('! ')) return true
    if (!line.startsWith('1 ')) return true
    const fields = line.split(' ')
    const xy = fields[1] ?? ''
    if (xy[1] !== 'M' || fields[6] !== fields[7]) return true
  }
  return false
}
