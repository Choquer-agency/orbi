let audio: HTMLAudioElement | null = null;

export function playNotificationSound() {
  try {
    if (!audio) {
      audio = new Audio('/notification.wav');
      audio.volume = 0.5;
    }
    audio.currentTime = 0;
    audio.play().catch(() => {
      // Silently ignore autoplay restrictions
    });
  } catch {
    // Audio not supported
  }
}
