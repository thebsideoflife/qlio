import { useSelector, useDispatch } from "react-redux";
import type { RootState } from "@/store/store";
import { splitSegment, selectSegment } from "@/store/editorSlice";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  Clock,
  Users,
  Tag,
  MessageSquare,
  Scissors,
  X,
} from "lucide-react";

export function SegmentDetailSidebar() {
  const dispatch = useDispatch();
  const selectedId = useSelector(
    (state: RootState) => state.editor.selectedSegmentId
  );
  const segment = useSelector((state: RootState) =>
    state.editor.segments.find((s) => s.id === selectedId)
  );

  if (!segment) {
    return null;
  }

  const duration = segment.endTime - segment.startTime;
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <div className="w-96 border-l bg-card overflow-y-auto h-full flex flex-col">
      <div className="p-6 space-y-6 flex-1">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <h2 className="text-xl font-bold">{segment.title}</h2>
            <p className="text-sm text-muted-foreground mt-1">
              {segment.description}
            </p>
          </div>
          <Button 
            variant="ghost" 
            size="icon" 
            className="h-8 w-8 -mt-1"
            onClick={() => dispatch(selectSegment(null))}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <h4 className="text-sm font-medium flex items-center gap-2">
              <Clock className="h-4 w-4" /> Timing
            </h4>
            <div className="grid grid-cols-3 gap-2 text-sm border rounded-lg p-3">
              <div>
                <div className="text-muted-foreground text-xs">Start</div>
                <div>{formatTime(segment.startTime)}</div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs">End</div>
                <div>{formatTime(segment.endTime)}</div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs">Duration</div>
                <div>{formatTime(duration)}</div>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <h4 className="text-sm font-medium flex items-center gap-2">
              <Users className="h-4 w-4" /> Characters
            </h4>
            <div className="flex flex-wrap gap-2">
              {segment.characters.map((char) => (
                <Badge key={char} variant="secondary">
                  {char}
                </Badge>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <h4 className="text-sm font-medium flex items-center gap-2">
              <Tag className="h-4 w-4" /> Scene Tags
            </h4>
            <div className="flex flex-wrap gap-2">
              {segment.sceneTags.map((tag) => (
                <Badge key={tag} variant="outline">
                  {tag}
                </Badge>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <h4 className="text-sm font-medium flex items-center gap-2">
              <MessageSquare className="h-4 w-4" /> Key Dialogue
            </h4>
            <blockquote className="border-l-2 pl-4 italic text-sm text-muted-foreground">
              "{segment.keyDialogue}"
            </blockquote>
          </div>

          <div className="space-y-2">
            <div className="flex justify-between text-sm font-medium">
              <span>AI Confidence Score</span>
              <span>{Math.round(segment.confidence * 100)}%</span>
            </div>
            <Progress value={segment.confidence * 100} className="h-2" />
          </div>

          <div className="space-y-2">
            <h4 className="text-sm font-medium">Metadata</h4>
            <div className="grid grid-cols-2 gap-y-2 text-sm">
              <div className="text-muted-foreground">Platform:</div>
              <div className="text-right font-medium">YouTube Shorts</div>

              <div className="text-muted-foreground">Content Type:</div>
              <div className="text-right font-medium">Clips</div>

              <div className="text-muted-foreground">Target Audience:</div>
              <div className="text-right font-medium">M/F, 18-34</div>

              <div className="text-muted-foreground">Purpose:</div>
              <div className="text-right font-medium">Marketing</div>
            </div>
          </div>
        </div>
      </div>

      <div className="p-4 border-t bg-background/50 sticky bottom-0">
        <Button
          className="w-full"
          variant="secondary"
          onClick={() => dispatch(splitSegment(segment.id))}
        >
          <Scissors className="h-4 w-4 mr-2" />
          Split Segment
        </Button>
      </div>
    </div>
  );
}
