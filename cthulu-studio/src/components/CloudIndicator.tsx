import { Cloud, CloudOff } from "lucide-react";
import { useCloud } from "../contexts/CloudContext";

export default function CloudIndicator() {
  const { enabled, connected, loading, org } = useCloud();

  if (!enabled) return null;

  if (loading) {
    return (
      <div className="cloud-indicator loading">
        <Cloud size={12} />
        <span>Connecting...</span>
      </div>
    );
  }

  if (!connected) {
    return (
      <div className="cloud-indicator disconnected">
        <CloudOff size={12} />
        <span>Offline</span>
      </div>
    );
  }

  return (
    <div className="cloud-indicator connected">
      <Cloud size={12} />
      <span>{org || "Cloud"}</span>
    </div>
  );
}
