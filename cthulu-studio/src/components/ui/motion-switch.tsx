import * as React from 'react'

import { Switch as SwitchPrimitive } from 'radix-ui'
import { motion } from 'motion/react'

import { cn } from '@/lib/utils'

const SIZES = {
  sm: { TRACK_WIDTH: 26, THUMB_SIZE: 14, THUMB_STRETCH: 18 },
  md: { TRACK_WIDTH: 32, THUMB_SIZE: 16, THUMB_STRETCH: 25 },
  lg: { TRACK_WIDTH: 48, THUMB_SIZE: 24, THUMB_STRETCH: 40 }
}

const STRETCH_DURATION = 120 // ms

type Size = keyof typeof SIZES

interface SwitchProps extends Omit<React.ComponentProps<typeof SwitchPrimitive.Root>, 'checked' | 'onCheckedChange' | 'defaultChecked'> {
  size?: Size
  checked?: boolean
  defaultChecked?: boolean
  onCheckedChange?: (checked: boolean) => void
}

function Switch({ className, size = 'md', checked: controlledChecked, defaultChecked, onCheckedChange, ...rest }: SwitchProps) {
  const { TRACK_WIDTH, THUMB_SIZE, THUMB_STRETCH } = SIZES[size]

  // Controlled vs uncontrolled: derive checked value without useEffect
  const isControlled = controlledChecked !== undefined
  const [internalChecked, setInternalChecked] = React.useState(defaultChecked ?? false)
  const isChecked = isControlled ? controlledChecked : internalChecked

  // Skip stretch animation on initial mount
  const isFirstRender = React.useRef(true)
  const [isStretching, setIsStretching] = React.useState(false)

  React.useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false
      return
    }
    setIsStretching(true)
    const timeout = setTimeout(() => setIsStretching(false), STRETCH_DURATION)
    return () => clearTimeout(timeout)
  }, [isChecked])

  const handleCheckedChange = React.useCallback((checked: boolean) => {
    if (!isControlled) {
      setInternalChecked(checked)
    }
    onCheckedChange?.(checked)
  }, [isControlled, onCheckedChange])

  const thumbWidth = isStretching ? THUMB_STRETCH : THUMB_SIZE
  const offsetUnchecked = 0
  const offsetChecked = TRACK_WIDTH - thumbWidth - 2

  const thumbLeft = isChecked ? offsetChecked : offsetUnchecked

  return (
    <SwitchPrimitive.Root
      data-slot='switch'
      {...rest}
      checked={isChecked}
      onCheckedChange={handleCheckedChange}
      className={cn(
        'peer data-[state=checked]:bg-primary data-[state=unchecked]:bg-input focus-visible:border-ring focus-visible:ring-ring/50 dark:data-[state=unchecked]:bg-input/80 relative inline-flex shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-4 w-6.5' : size === 'lg' ? 'h-7 w-12' : 'h-[1.15rem] w-8',
        className
      )}
    >
      <SwitchPrimitive.Thumb asChild>
        <motion.span
          data-slot='switch-thumb'
          className='bg-background dark:data-[state=unchecked]:bg-foreground dark:data-[state=checked]:bg-primary-foreground pointer-events-none absolute block rounded-full ring-0'
          animate={{
            width: thumbWidth,
            left: thumbLeft,
            transition: { duration: STRETCH_DURATION / 1000 }
          }}
          style={{
            height: THUMB_SIZE,
            minWidth: THUMB_SIZE,
            maxWidth: THUMB_STRETCH
          }}
        />
      </SwitchPrimitive.Thumb>
    </SwitchPrimitive.Root>
  )
}

export { Switch }
