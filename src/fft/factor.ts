/** Prime factorization, smallest factor first. factor(1) = []. */
export function primeFactors(n: number): number[] {
  const out: number[] = []
  let m = n
  for (let p = 2; p * p <= m; p += p === 2 ? 1 : 2) {
    while (m % p === 0) {
      out.push(p)
      m /= p
    }
  }
  if (m > 1) out.push(m)
  return out
}

/** Smallest m >= n whose prime factors are all in {2, 3, 5}. */
export function nextSmooth(n: number): number {
  for (let m = Math.max(1, n); ; m++) {
    let r = m
    while (r % 2 === 0) r /= 2
    while (r % 3 === 0) r /= 3
    while (r % 5 === 0) r /= 5
    if (r === 1) return m
  }
}

/**
 * Split n into Stockham stage radices. Radix 4 is preferred for powers of two
 * (fewest passes with a cheap butterfly), then 2, 3, 5, then any other primes.
 */
export function radixPlan(n: number): number[] {
  const primes = primeFactors(n)
  let twos = primes.filter((p) => p === 2).length
  const rest = primes.filter((p) => p !== 2)
  const radices: number[] = []
  while (twos >= 2) {
    radices.push(4)
    twos -= 2
  }
  if (twos === 1) radices.push(2)
  return radices.concat(rest)
}
