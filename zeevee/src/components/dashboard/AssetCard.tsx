import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MoreHorizontal, Edit, Download, ChevronDown, CheckCircle, Activity } from "lucide-react";
import type { Asset } from "@/store/assetsSlice";
import { useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Progress } from "@/components/ui/progress";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface AssetCardProps {
  asset: Asset;
}

const stageLabels: Record<string, string> = {
  upload: 'Upload',
  transcription: 'Transcription',
  clip_selection: 'Segment Selection',
  reframing: 'Reframing',
  captions: 'Captions',
  delivery: 'Delivery',
};

export function AssetCard({ asset }: AssetCardProps) {
  const navigate = useNavigate();

  const handleCardClick = () => {
    navigate("/editor");
  };

  const stages = asset.processing ? [
    { id: 'upload', label: 'Upload', progress: asset.processing.stages.upload },
    { id: 'transcription', label: 'Transcription', progress: asset.processing.stages.transcription },
    { id: 'clip_selection', label: 'Segment Selection', progress: asset.processing.stages.clip_selection },
    { id: 'reframing', label: 'Reframing', progress: asset.processing.stages.reframing },
    { id: 'captions', label: 'Captions', progress: asset.processing.stages.captions },
    { id: 'delivery', label: 'Delivery', progress: asset.processing.stages.delivery },
  ] : [];

  const currentStageLabel = asset.processing?.stage ? stageLabels[asset.processing.stage] : '';

  return (
    <Card 
        className="overflow-hidden flex flex-col justify-between group cursor-pointer hover:border-primary/50 transition-all"
        onClick={handleCardClick}
    >
      <div className="relative aspect-video w-full bg-muted overflow-hidden">
        <img
          src={asset.thumbnail}
          alt={asset.title}
          className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
        />
        <div className="absolute top-2 left-2 z-10">
          {asset.status === "processing" && asset.processing ? (
            <Popover>
              <PopoverTrigger asChild onClick={(e) => e.stopPropagation()}>
                <Badge
                  variant="secondary"
                  className="bg-blue-500 hover:bg-blue-600 text-white cursor-pointer transition-all flex items-center gap-1.5"
                >
                  <Activity className="h-3 w-3 animate-pulse" />
                  {currentStageLabel}
                  <ChevronDown className="h-3 w-3" />
                </Badge>
              </PopoverTrigger>
              <PopoverContent className="w-80 p-4" align="start" onClick={(e) => e.stopPropagation()}>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm font-semibold">
                      <span>Overall Progress</span>
                      <span>{asset.processing.progress}%</span>
                    </div>
                    <Progress value={asset.processing.progress} className="h-2" />
                  </div>
                  
                  <div className="space-y-3">
                    {stages.map((stage, index) => (
                      <div key={stage.id} className="flex items-center gap-3 text-sm">
                        <div className={cn(
                          "flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-medium shrink-0",
                          stage.progress === 100
                            ? "bg-green-500 text-white"
                            : stage.progress > 0
                              ? "bg-blue-500 text-white"
                              : "bg-muted-foreground/20 text-muted-foreground"
                        )}>
                          {stage.progress === 100 ? <CheckCircle className="h-3 w-3" /> : index + 1}
                        </div>
                        <div className="flex-1 font-medium">{stage.label}</div>
                        <div className="w-20 h-1.5 bg-muted rounded-full overflow-hidden">
                          <div
                            className={cn(
                              "h-full transition-all duration-500",
                              stage.progress === 100 ? "bg-green-500" : "bg-blue-500"
                            )}
                            style={{ width: `${stage.progress}%` }}
                          />
                        </div>
                        <div className="w-10 text-right text-muted-foreground text-xs">{stage.progress}%</div>
                      </div>
                    ))}
                  </div>

                  <div className="text-xs text-muted-foreground pt-2 border-t">
                    ETA: {new Date(asset.processing.eta).toLocaleTimeString()}
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          ) : (
            <Badge
              variant="default"
              className="bg-green-500 hover:bg-green-600"
            >
              {asset.status}
            </Badge>
          )}
        </div>
        <div className="absolute bottom-2 right-2 bg-black/60 text-white text-xs px-1.5 py-0.5 rounded">
          44m
        </div>
      </div>

      <CardContent className="p-5">
        <h3
          className="font-semibold leading-tight truncate mb-2 text-base group-hover:text-primary transition-colors"
          title={asset.title}
        >
          {asset.title}
        </h3>

        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm text-muted-foreground">
          <div>Format:</div>
          <div className="text-right text-foreground">{asset.format}</div>

          <div>Size:</div>
          <div className="text-right text-foreground">{asset.size}</div>

          <div>Segments:</div>
          <div className="text-right text-foreground">{asset.segmentCount}</div>

          <div>Views:</div>
          <div className="text-right text-foreground">
            {asset.views.toLocaleString()}
          </div>
        </div>
      </CardContent>

      <CardFooter className="p-4 pt-0 flex justify-between items-center">
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={(e) => {
                e.stopPropagation();
                navigate("/editor");
            }}
            disabled={asset.status !== "completed"}
          >
            <Edit className="h-4 w-4 mr-1" />
            Edit
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={(e) => e.stopPropagation()}>
            <Download className="h-4 w-4" />
          </Button>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={(e) => e.stopPropagation()}>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </CardFooter>
    </Card>
  );
}
