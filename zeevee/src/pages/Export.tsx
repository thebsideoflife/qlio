import { useParams, useNavigate, Link } from "react-router-dom";
import { useSelector } from "react-redux";
import type { RootState } from "@/store/store";
import { useProjectData } from "@/hooks/useProjectData";
import { ExportPanel } from "@/components/editor/ExportPanel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export default function Export() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { loading, error } = useProjectData(projectId);
  const segments = useSelector((state: RootState) => state.editor.segments);

  if (!projectId) return null;

  if (loading) {
    return (
      <div className="flex flex-col h-[calc(100dvh-3.5rem)] sm:h-[calc(100dvh-4rem)] min-h-0 p-4 sm:p-6 max-w-[90rem] mx-auto w-full gap-4 overflow-hidden">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="flex-1 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-[calc(100vh-4rem)] gap-4">
        <p className="text-muted-foreground">{error}</p>
        <Button variant="outline" asChild>
          <Link to="/">Back to dashboard</Link>
        </Button>
      </div>
    );
  }

  if (segments.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-[calc(100vh-4rem)] gap-4">
        <p className="text-muted-foreground">No segments to export yet.</p>
        <Button onClick={() => navigate(`/editor/${projectId}`)}>
          Back to editor
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100dvh-3.5rem)] sm:h-[calc(100dvh-4rem)] min-h-0 p-4 sm:p-6 max-w-[90rem] mx-auto w-full overflow-hidden">
      <ExportPanel
        projectId={projectId}
        onDone={() => navigate(`/editor/${projectId}`)}
      />
    </div>
  );
}
