import { ArrowDownWideNarrow } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/IconButton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { hostSortOrders, type HostSort } from "./host-sort";

export function HostSortMenu({ order, onChange }: { order: HostSort; onChange(order: HostSort): void }) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={t("hosts.sort.label", { order: t(`hosts.sort.${order}`) })}>
          <ArrowDownWideNarrow />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={order}>
          {hostSortOrders.map((option) => (
            <DropdownMenuRadioItem key={option} value={option} onSelect={() => onChange(option)}>
              {t(`hosts.sort.${option}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
