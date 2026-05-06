import { isNative } from './platform';

interface ShareOptions {
  title: string;
  text: string;
  url?: string;
}

export async function shareContent(options: ShareOptions): Promise<void> {
  if (isNative()) {
    try {
      const { Share } = await import('@capacitor/share');
      await Share.share({
        title: options.title,
        text: options.text,
        url: options.url,
        dialogTitle: 'Share Email',
      });
      return;
    } catch {
      // User cancelled or plugin unavailable — fall through to web
    }
  }

  // Web fallback
  if (navigator.share) {
    try {
      await navigator.share(options);
    } catch {
      // User cancelled
    }
  }
}
