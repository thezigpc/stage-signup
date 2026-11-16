import { useEffect, useState } from "react";

/** A short-lived message (a refused action, a server notice). */
export function useToast() {
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  return { toast, setToast };
}
