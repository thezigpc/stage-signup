import { useEffect, useState } from "react";
import QRCode from "qrcode";

export function QrCode({ text, size = 160, className = "qr" }: { text: string; size?: number; className?: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    QRCode.toDataURL(text, { margin: 1, width: size * 2 })
      .then(setSrc)
      .catch(() => setSrc(""));
  }, [text, size]);
  return src ? <img className={className} src={src} width={size} height={size} alt={`QR code for ${text}`} /> : null;
}
