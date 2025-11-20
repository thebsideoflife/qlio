import { Card, CardContent } from "@/components/ui/card";
import type { LucideIcon } from "lucide-react";

interface StatCardProps {
  title: string;
  value: string | number;
  description?: string;
  icon: LucideIcon;
  iconColor?: string;
  bgColor?: string;
}

export function StatCard({
  title,
  value,
  icon: Icon,
  iconColor,
  bgColor,
}: StatCardProps) {
  return (
    <Card className="bg-card">
      <CardContent className="p-6 flex items-center gap-4">
        <div className={`p-3 rounded-lg ${bgColor || "bg-muted"}`}>
          <Icon className={`h-6 w-6 ${iconColor || "text-foreground"}`} />
        </div>
        <div>
          <div className="text-2xl font-bold">{value}</div>
          <div className="text-sm font-medium text-muted-foreground">
            {title}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
