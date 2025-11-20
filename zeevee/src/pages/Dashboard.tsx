import { useSelector } from "react-redux";
import type { RootState } from "@/store/store";
import { AssetCard } from "@/components/dashboard/AssetCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Play,
  CheckCircle,
  Share2,
  Eye,
  Search,
  Filter,
  Upload,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UploadWizard } from "@/components/upload/UploadWizard";
import { useState } from "react";

export default function Dashboard() {
  const assets = useSelector((state: RootState) => state.assets.items);
  const [isUploadOpen, setIsUploadOpen] = useState(false);

  // Derived stats
  const totalAssets = assets.length;
  const processed = assets.filter((a) => a.status === "completed").length;
  const totalClips = assets.reduce((acc, curr) => acc + curr.segmentCount, 0);
  const totalViews = assets.reduce((acc, curr) => acc + curr.views, 0);

  return (
    <div className="space-y-6">
      {/* Header Section with Inline Stats */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-3xl font-bold tracking-tight">
              Asset Management
            </h2>
            <p className="text-muted-foreground">
              Manage your video content and processing pipeline
            </p>
          </div>
          <Button
            onClick={() => setIsUploadOpen(true)}
            className="bg-blue-600 hover:bg-blue-700"
          >
            <Upload className="mr-2 h-4 w-4" />
            Upload
          </Button>
        </div>

        {/* Compact Inline Stats */}
        <div className="flex items-center gap-6 text-sm">
          <div className="flex items-center gap-2">
            <Play className="h-4 w-4 text-blue-500" />
            <span className="font-semibold">{totalAssets}</span>
            <span className="text-muted-foreground">Assets</span>
          </div>
          <div className="h-4 w-px bg-border" />
          <div className="flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-green-500" />
            <span className="font-semibold">{processed}</span>
            <span className="text-muted-foreground">Processed</span>
          </div>
          <div className="h-4 w-px bg-border" />
          <div className="flex items-center gap-2">
            <Share2 className="h-4 w-4 text-purple-500" />
            <span className="font-semibold">{totalClips}</span>
            <span className="text-muted-foreground">Segments</span>
          </div>
          <div className="h-4 w-px bg-border" />
          <div className="flex items-center gap-2">
            <Eye className="h-4 w-4 text-orange-500" />
            <span className="font-semibold">{totalViews.toLocaleString()}</span>
            <span className="text-muted-foreground">Views</span>
          </div>
        </div>
      </div>

      {/* Filters & Search */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search assets..."
            className="pl-8 w-full md:w-[300px]"
          />
        </div>
        <div className="flex items-center gap-2">
          <Select defaultValue="all">
            <SelectTrigger className="w-[130px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="processing">Processing</SelectItem>
            </SelectContent>
          </Select>
          <Select defaultValue="all">
            <SelectTrigger className="w-[130px]">
              <SelectValue placeholder="Purpose" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Purpose</SelectItem>
              <SelectItem value="marketing">Marketing</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon">
            <Filter className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Assets Grid */}
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {assets.map((asset) => (
          <AssetCard key={asset.id} asset={asset} />
        ))}
      </div>

      {/* Upload Wizard Modal */}
      <UploadWizard open={isUploadOpen} onOpenChange={setIsUploadOpen} />
    </div>
  );
}
