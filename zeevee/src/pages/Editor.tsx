import { Timeline } from '@/components/editor/Timeline';
import { SegmentDetailSidebar } from '@/components/editor/SegmentDetailSidebar';
import { Play } from 'lucide-react';
import { useSelector, useDispatch } from 'react-redux';
import type { RootState } from '@/store/store';
import { selectSegment } from '@/store/editorSlice';

export default function Editor() {
  const dispatch = useDispatch();
  const selectedSegmentId = useSelector((state: RootState) => state.editor.selectedSegmentId);

  const handleBackgroundClick = () => {
    if (selectedSegmentId) {
      dispatch(selectSegment(null));
    }
  };

  return (
    <div className="flex h-[calc(100vh-4rem)] -m-8"> {/* Match MainLayout's padding and header height */}
      
      {/* Main Content (Video + Timeline) */}
      <div className="flex-1 flex flex-col min-w-0 bg-background">
        {/* Video Player Area */}
        <div 
          className="flex-1 bg-black relative flex items-center justify-center group min-h-0"
          onClick={handleBackgroundClick}
        >
             <img 
                src="https://images.unsplash.com/photo-1534447677768-be436bb09401?w=1200&auto=format&fit=crop&q=80" 
                alt="Video Preview" 
                className="max-h-full w-auto opacity-80"
             />
             <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                <div className="h-16 w-16 bg-white/20 rounded-full flex items-center justify-center backdrop-blur-sm cursor-pointer hover:bg-white/30 transition-all pointer-events-auto">
                    <Play className="h-8 w-8 text-white fill-current" />
                </div>
             </div>
        </div>

        {/* Timeline Area */}
        <div className="h-48 border-t bg-card p-4">
             <div className="flex justify-between items-center mb-3">
                <div className="text-sm font-medium">Timeline</div>
                <div className="flex gap-2 text-xs text-muted-foreground">
                    <span>Total Segments: 12</span>
                    <span>Coverage: 36%</span>
                    <span>Avg Confidence: 90%</span>
                </div>
             </div>
             <Timeline />
        </div>
      </div>

      {/* Right Sidebar - Only show when segment is selected */}
      {selectedSegmentId && <SegmentDetailSidebar />}
      
    </div>
  );
}
