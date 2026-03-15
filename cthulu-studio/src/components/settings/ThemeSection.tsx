import { useTheme } from "@/lib/ThemeContext";
import { themes } from "@/lib/themes";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export default function ThemeSection() {
  const { theme, setThemeId } = useTheme();
  const branded = themes.filter((t) => t.group === "branded");
  const presets = themes.filter((t) => t.group === "preset");

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <span className="settings-section-title">Theme</span>
      </div>
      <div className="settings-section-body">
        <div className="settings-row">
          <span className="settings-label">Color theme</span>
          <Select value={theme.id} onValueChange={setThemeId}>
            <SelectTrigger size="sm" className="text-xs h-8 min-w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" sideOffset={4}>
              <SelectGroup>
                <SelectLabel>Branded</SelectLabel>
                {branded.map((t) => (
                  <SelectItem key={t.id} value={t.id} className="text-xs">
                    {t.label}
                  </SelectItem>
                ))}
              </SelectGroup>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>Presets</SelectLabel>
                {presets.map((t) => (
                  <SelectItem key={t.id} value={t.id} className="text-xs">
                    {t.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <div className="settings-hint">
          Current: {theme.label} ({theme.colorScheme})
        </div>
      </div>
    </div>
  );
}
