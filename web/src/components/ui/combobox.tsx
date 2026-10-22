import { Autocomplete } from "@base-ui-components/react/autocomplete";
import { useTranslation } from "react-i18next";

/**
 * Free-text input with filtered suggestions. Built on Autocomplete rather than
 * Combobox: in Combobox's single-selection mode, closing the popup without
 * picking an item resets the input, wiping paths typed by hand. Here the typed
 * value is the source of truth and always survives blur/escape.
 */
export function Combobox({
  value,
  onValueChange,
  items,
  placeholder,
}: {
  value: string;
  onValueChange: (value: string) => void;
  items: string[];
  placeholder?: string;
}) {
  const { t } = useTranslation();
  return (
    <Autocomplete.Root
      items={items}
      value={value}
      onValueChange={onValueChange}
      openOnInputClick
    >
      <Autocomplete.Input
        placeholder={placeholder}
        className="h-6.5 w-full border border-border bg-bg px-2 text-xs text-fg placeholder:text-faint focus:border-fg focus:outline-none"
      />
      <Autocomplete.Portal>
        <Autocomplete.Positioner sideOffset={4} className="z-50 outline-none">
          <Autocomplete.Popup className="max-h-64 w-[var(--anchor-width)] overflow-y-auto border border-border-strong bg-bg py-1 outline-none">
            <Autocomplete.Empty className="px-2 py-1 font-mono text-2xs text-faint">
              {t("no known directory matches — the typed path is used as-is")}
            </Autocomplete.Empty>
            <Autocomplete.List>
              {(item: string) => (
                <Autocomplete.Item
                  key={item}
                  value={item}
                  className="cursor-pointer truncate px-2 py-1 font-mono text-2xs text-fg outline-none data-[highlighted]:bg-hover"
                >
                  {item}
                </Autocomplete.Item>
              )}
            </Autocomplete.List>
          </Autocomplete.Popup>
        </Autocomplete.Positioner>
      </Autocomplete.Portal>
    </Autocomplete.Root>
  );
}
