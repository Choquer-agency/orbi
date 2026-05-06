import { useRef, useEffect, useCallback, useState } from 'react';
import { haptic } from '../lib/haptics';

interface UsePullToRefreshOptions {
  onRefresh: () => Promise<any>;
  enabled?: boolean;
  threshold?: number;
}

export function usePullToRefresh({ onRefresh, enabled = true, threshold = 80 }: UsePullToRefreshOptions) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const touchRef = useRef<{ startY: number; pulling: boolean } | null>(null);
  const hapticFiredRef = useRef(false);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    haptic.light();
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
      setPullDistance(0);
    }
  }, [onRefresh]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !enabled) return;

    const onTouchStart = (e: TouchEvent) => {
      if (isRefreshing) return;
      // Only record start position — don't commit to pulling yet
      touchRef.current = { startY: e.touches[0].clientY, pulling: false };
      hapticFiredRef.current = false;
    };

    const onTouchMove = (e: TouchEvent) => {
      const ref = touchRef.current;
      if (!ref || isRefreshing) return;

      // If we're not already pulling, check if we should start
      if (!ref.pulling) {
        // Only start a pull if scrolled to the very top
        if (el.scrollTop > 0) {
          // User is scrolled down — this is a normal scroll, ignore entirely
          touchRef.current = null;
          return;
        }
        const dy = e.touches[0].clientY - ref.startY;
        if (dy <= 0) {
          // Scrolling up — not a pull gesture
          touchRef.current = null;
          return;
        }
        // We're at scrollTop 0 and pulling down — commit to pull mode
        ref.pulling = true;
        // Reset startY to current position so pull distance starts from 0
        ref.startY = e.touches[0].clientY;
      }

      // In pull mode
      const dy = e.touches[0].clientY - ref.startY;
      if (dy > 0) {
        const distance = Math.min(dy * 0.5, threshold * 2);
        setPullDistance(distance);

        if (!hapticFiredRef.current && distance >= threshold) {
          hapticFiredRef.current = true;
          haptic.light();
        }
      } else {
        setPullDistance(0);
      }
    };

    const onTouchEnd = () => {
      const ref = touchRef.current;
      if (!ref || !ref.pulling) {
        touchRef.current = null;
        return;
      }

      if (pullDistance >= threshold) {
        handleRefresh();
      } else {
        setPullDistance(0);
      }
      touchRef.current = null;
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
    };
  }, [enabled, threshold, isRefreshing, pullDistance, handleRefresh]);

  return { scrollRef, pullDistance, isRefreshing };
}
