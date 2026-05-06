import { isNative } from './platform';
import { haptic } from './haptics';

interface ActionSheetOption {
  title: string;
  destructive?: boolean;
}

interface ActionSheetResult {
  index: number;
}

/**
 * Shows a native iOS action sheet on Capacitor, or returns the index
 * via a promise. Returns -1 if cancelled.
 */
export async function showActionSheet(
  title: string,
  options: ActionSheetOption[],
): Promise<number> {
  haptic.light();

  if (isNative()) {
    try {
      const { ActionSheet } = await import('@capacitor/action-sheet');
      const result: ActionSheetResult = await ActionSheet.showActions({
        title,
        options: options.map((o) => ({
          title: o.title,
          style: o.destructive ? ('DESTRUCTIVE' as any) : undefined,
        })),
      });
      return result.index;
    } catch {
      // Cancelled or plugin unavailable
      return -1;
    }
  }

  // Web fallback: not used (web uses Radix ContextMenu instead)
  return -1;
}
