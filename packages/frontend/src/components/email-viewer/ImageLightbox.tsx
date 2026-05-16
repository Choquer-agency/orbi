import { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Download, X } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';

interface ImageLightboxProps {
  src: string | null;
  alt?: string;
  onClose: () => void;
  onDownload?: (src: string, alt?: string) => void;
}

export function ImageLightbox({ src, alt, onClose, onDownload }: ImageLightboxProps) {
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const lastTouchDistance = useRef<number | null>(null);
  const lastTouchCenter = useRef<{ x: number; y: number } | null>(null);
  const isDragging = useRef(false);

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      lastTouchDistance.current = Math.sqrt(dx * dx + dy * dy);
      lastTouchCenter.current = {
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
      };
    } else if (e.touches.length === 1 && scale > 1) {
      isDragging.current = true;
      lastTouchCenter.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && lastTouchDistance.current !== null) {
      e.preventDefault();
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const newDistance = Math.sqrt(dx * dx + dy * dy);
      const ratio = newDistance / lastTouchDistance.current;
      setScale((prev) => Math.max(0.5, Math.min(prev * ratio, 5)));
      lastTouchDistance.current = newDistance;
    } else if (e.touches.length === 1 && isDragging.current && lastTouchCenter.current) {
      const dx = e.touches[0].clientX - lastTouchCenter.current.x;
      const dy = e.touches[0].clientY - lastTouchCenter.current.y;
      setTranslate((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
      lastTouchCenter.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  };

  const handleTouchEnd = () => {
    lastTouchDistance.current = null;
    isDragging.current = false;
    if (scale <= 1) {
      setTranslate({ x: 0, y: 0 });
      setScale(1);
    }
  };

  const handleDoubleTap = () => {
    if (scale > 1) {
      setScale(1);
      setTranslate({ x: 0, y: 0 });
    } else {
      setScale(2.5);
    }
  };

  return (
    <AnimatePresence>
      {src && (
        <motion.div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={(e) => {
            if (e.target === e.currentTarget && scale <= 1) onClose();
          }}
        >
          <div className="absolute right-4 top-4 z-10 flex items-center gap-2">
            {onDownload && (
              <Tooltip content="Download image" side="bottom">
                <button
                  onClick={() => src && onDownload(src, alt)}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-orange-500 text-white transition-colors hover:bg-orange-600"
                  aria-label="Download image"
                >
                  <Download className="h-4 w-4" />
                </button>
              </Tooltip>
            )}
            <Tooltip content="Close" side="bottom">
              <button
                onClick={onClose}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-orange-500 text-white transition-colors hover:bg-orange-600"
                aria-label="Close image preview"
              >
                <X className="h-4 w-4" />
              </button>
            </Tooltip>
          </div>
          <img
            src={src}
            alt={alt || 'Image preview'}
            className="max-h-[90vh] max-w-[90vw] select-none object-contain"
            style={{
              transform: `scale(${scale}) translate(${translate.x / scale}px, ${translate.y / scale}px)`,
              transition: lastTouchDistance.current ? 'none' : 'transform 0.2s ease-out',
            }}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onDoubleClick={handleDoubleTap}
            draggable={false}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
