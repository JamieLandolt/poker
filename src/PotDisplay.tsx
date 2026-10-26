import { useEffect, useRef, useState } from 'react'

/** The pot: glowing gradient number that counts up and pops whenever chips go in. */
export default function PotDisplay({ amount }: { amount: number }) {
  const [shown, setShown] = useState(amount)
  const [pop, setPop] = useState(0)
  const from = useRef(amount)
  const raf = useRef(0)

  useEffect(() => {
    if (amount === from.current) return
    const start = performance.now()
    const a = from.current
    const dur = amount > a ? 450 : 200
    cancelAnimationFrame(raf.current)
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / dur)
      const eased = 1 - Math.pow(1 - k, 3)
      setShown(Math.round(a + (amount - a) * eased))
      if (k < 1) raf.current = requestAnimationFrame(step)
      else from.current = amount
    }
    raf.current = requestAnimationFrame(step)
    if (amount > a) setPop((n) => n + 1)
    return () => { cancelAnimationFrame(raf.current); from.current = amount }
  }, [amount])

  const empty = amount === 0
  return (
    <div className={`pot ${empty ? 'pot-empty' : ''}`}>
      <div className="pot-label">POT</div>
      <div key={pop} className={`pot-num num ${pop ? 'pot-pop' : ''}`}>{shown.toLocaleString()}</div>
    </div>
  )
}
