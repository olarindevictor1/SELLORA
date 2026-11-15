import React, { useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';

export const OfflineIndicator: React.FC = () => {
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  if (isOnline) return null;

  return (
    <div
      role="status"
      className="fixed bottom-4 left-4 z-50 inline-flex items-center gap-2 rounded-lg bg-[#172554] px-3.5 py-2 text-xs font-medium text-[#B7F36B] shadow-lg border border-white/10"
    >
      <WifiOff className="w-3.5 h-3.5" />
      <span>You are offline — showing cached storefront view.</span>
    </div>
  );
};
