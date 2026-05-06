import { useRef, useState } from 'react';
import { Camera, Loader2, Check } from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';
import { getInitials } from '../../lib/utils';
import toast from 'react-hot-toast';

function resizeImage(file: File, size: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d')!;
      // Center-crop: use the largest square from the source
      const min = Math.min(img.width, img.height);
      const sx = (img.width - min) / 2;
      const sy = (img.height - min) / 2;
      ctx.drawImage(img, sx, sy, min, min, 0, 0, size, size);
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

export function ProfileSettings() {
  const { user, updateUser } = useAuthStore();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(user?.name ?? '');
  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  if (!user) return null;

  const hasNameChange = name.trim() !== user.name;

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingAvatar(true);
    try {
      const dataUrl = await resizeImage(file, 256);
      await updateUser({ avatarUrl: dataUrl });
      toast.success('Avatar updated');
    } catch {
      toast.error('Failed to update avatar');
    } finally {
      setUploadingAvatar(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleSaveName = async () => {
    if (!hasNameChange) return;
    setSaving(true);
    try {
      await updateUser({ name: name.trim() });
      toast.success('Name updated');
    } catch {
      toast.error('Failed to update name');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Avatar */}
      <div className="flex flex-col items-center gap-3">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="group relative h-24 w-24 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          disabled={uploadingAvatar}
        >
          {user.avatarUrl ? (
            <img
              src={user.avatarUrl}
              alt={user.name}
              className="h-full w-full rounded-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center rounded-full bg-primary/15 text-2xl font-semibold text-primary">
              {getInitials(user.name)}
            </div>
          )}
          {/* Overlay */}
          <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/0 transition-colors group-hover:bg-black/30">
            {uploadingAvatar ? (
              <Loader2 className="h-6 w-6 animate-spin text-white" />
            ) : (
              <Camera className="h-6 w-6 text-white opacity-0 transition-opacity group-hover:opacity-100" />
            )}
          </div>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleAvatarChange}
        />
        <p className="text-[11px] text-text-tertiary">Tap to change photo</p>
      </div>

      {/* Name */}
      <div className="space-y-1.5">
        <label htmlFor="profile-name" className="text-xs font-medium text-text-secondary">
          Display Name
        </label>
        <div className="flex gap-2">
          <input
            id="profile-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="flex-1 rounded-lg border border-border bg-white px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary"
          />
          <button
            onClick={handleSaveName}
            disabled={!hasNameChange || saving}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary/90 disabled:opacity-40"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Save
          </button>
        </div>
      </div>

      {/* Read-only info */}
      <div className="space-y-4">
        <div className="space-y-1">
          <p className="text-xs font-medium text-text-secondary">Email</p>
          <p className="text-sm text-text-primary">{user.email}</p>
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium text-text-secondary">Role</p>
          <p className="text-sm capitalize text-text-primary">{user.role.toLowerCase()}</p>
        </div>
      </div>
    </div>
  );
}
