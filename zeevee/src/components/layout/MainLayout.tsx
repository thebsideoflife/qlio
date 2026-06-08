import { useEffect, useState, useMemo } from "react";
import {
  LogOut,
  KeyRound,
  Plus,
  Search,
  RefreshCcw,
  ChevronRight,
  Film,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModeToggle } from "@/components/mode-toggle";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useDispatch, useSelector } from "react-redux";
import { pollAssetStatuses } from "@/store/assetsSlice";
import { updateProjectTitle } from "@/store/editorSlice";
import type { RootState, AppDispatch } from "@/store/store";
import { UploadWizard } from "@/components/upload/UploadWizard";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EditableTitle } from "@/components/ui/editable-title";
import { cn } from "@/lib/utils";

interface MainLayoutProps {
  children: React.ReactNode;
}

export function MainLayout({ children }: MainLayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();
  // We need to get projectId from params if we are in editor, but MainLayout wraps routes.
  // Location pathname parsing is safest or using a context, but we can try useParams.
  // Note: useParams might be empty here because MainLayout is outside the Route with :projectId?
  // Let's rely on checking pathname.

  const dispatch = useDispatch<AppDispatch>();
  const { items: assets } = useSelector((state: RootState) => state.assets);
  const { projectTitle, assetName } = useSelector(
    (state: RootState) => state.editor,
  );

  const isEditorPage = location.pathname.startsWith("/editor");
  const isExportPage = /\/export$/.test(location.pathname);
  const projectIdFromPath = isEditorPage
    ? location.pathname.split("/")[2]
    : null;

  const isDashboardPage = location.pathname === "/";

  const [isPasswordOpen, setIsPasswordOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const processingCount = useMemo(
    () =>
      assets.filter(
        (a) =>
          a.status === "processing" ||
          a.status === "uploading" ||
          a.status === "indexing",
      ).length,
    [assets],
  );

  const completedCount = useMemo(
    () =>
      assets.filter((a) => a.status === "completed" || a.status === "READY")
        .length,
    [assets],
  );

  // Listen for custom event to open upload wizard from other components
  useEffect(() => {
    const handleOpenUpload = () => setUploadOpen(true);
    window.addEventListener("open-upload-wizard", handleOpenUpload);
    return () =>
      window.removeEventListener("open-upload-wizard", handleOpenUpload);
  }, []);

  const handleLogout = () => {
    localStorage.removeItem("api_password");
    navigate("/signin");
  };

  const handlePasswordChange = () => {
    if (newPassword) {
      localStorage.setItem("api_password", newPassword);
      setIsPasswordOpen(false);
      setNewPassword("");
      // Ideally show a toast here
    }
  };

  return (
    <div className="flex h-screen w-full flex-col bg-background text-foreground overflow-hidden">
      <header className="flex h-14 sm:h-16 items-center justify-between border-b-2 border-border px-4 sm:px-8 bg-card gap-3 sm:gap-6">
        <Link
          to="/"
          className="flex items-center gap-3 font-bold hover:opacity-80 transition-opacity"
        >
          <img src="/qlio.svg" alt="" className="h-8 w-8" />
          <span className="text-xl">Qlio</span>
        </Link>

        {/* Editor page info and actions in header */}
        {isEditorPage && (
          <>
            <div
              className={cn(
                "flex-1 flex items-center justify-center min-w-0",
                isExportPage && "hidden md:flex",
              )}
            >
              <div className="text-center flex flex-col items-center min-w-0 max-w-full">
                <div className="flex items-center gap-2 text-sm min-w-0 max-w-full">
                  <span
                    className="text-muted-foreground max-w-[120px] sm:max-w-[200px] truncate font-medium"
                    title={assetName}
                  >
                    {assetName}
                  </span>
                  <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />

                  {projectIdFromPath && (
                    <EditableTitle
                      title={projectTitle || "Untitled"}
                      onSave={(newTitle) =>
                        dispatch(updateProjectTitle(newTitle))
                      }
                      className="font-bold underline decoration-dotted decoration-muted-foreground/50 underline-offset-4 hover:bg-muted/50 px-1 py-0 rounded truncate max-w-[140px] sm:max-w-none"
                      inputClassName="h-7 px-1.5 py-0 text-sm font-bold border-border focus-visible:ring-1"
                    />
                  )}
                </div>
              </div>
            </div>
            <div className="flex gap-3 shrink-0">
              {isExportPage && projectIdFromPath ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => navigate(`/editor/${projectIdFromPath}`)}
                >
                  Back to Editor
                </Button>
              ) : (
                projectIdFromPath && (
                  <Button
                    size="sm"
                    onClick={() =>
                      navigate(`/editor/${projectIdFromPath}/export`)
                    }
                  >
                    <Film className="h-4 w-4 mr-2" />
                    Export Video
                  </Button>
                )
              )}
            </div>
          </>
        )}

        {/* Dashboard page info and actions in header */}
        {isDashboardPage && (
          <>
            <div className="flex-1 flex items-center ml-4">
              <div className="flex items-center gap-5 text-sm text-muted-foreground border-l-2 border-border pl-5 h-8">
                <div>
                  <span className="font-bold text-foreground">
                    {assets.length}
                  </span>{" "}
                  <span className="font-medium">Total</span>
                </div>
                <div>
                  <span className="font-bold text-foreground">
                    {processingCount}
                  </span>{" "}
                  <span className="font-medium">Processing</span>
                </div>
                <div>
                  <span className="font-bold text-foreground">
                    {completedCount}
                  </span>{" "}
                  <span className="font-medium">Completed</span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="relative w-64 hidden lg:block">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search assets..."
                  className="pl-10 h-10 bg-background border-2 border-border focus:border-blue-500"
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => dispatch(pollAssetStatuses())}
              >
                <RefreshCcw className="h-4 w-4" />
              </Button>
              <Button size="sm" onClick={() => setUploadOpen(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Upload
              </Button>
            </div>
          </>
        )}

        <div className="flex items-center gap-4">
          <ModeToggle />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Avatar className="h-9 w-9 cursor-pointer border-2 border-border hover:border-blue-500 transition-colors">
                <AvatarImage src="/placeholder-user.jpg" alt="User" />
                <AvatarFallback className="bg-muted font-bold">
                  U
                </AvatarFallback>
              </Avatar>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="bg-card border-border">
              <DropdownMenuLabel className="font-bold">
                My Account
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setIsPasswordOpen(true)}>
                <KeyRound className="mr-2 h-4 w-4" />
                Edit API Password
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={handleLogout}
                className="text-red-500 focus:text-red-400"
              >
                <LogOut className="mr-2 h-4 w-4" />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <main className="flex-1 overflow-auto bg-background">{children}</main>

      <Dialog open={isPasswordOpen} onOpenChange={setIsPasswordOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit API Password</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="password" className="text-right">
                New Password
              </Label>
              <Input
                id="password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="col-span-3"
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={handlePasswordChange}>Save changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <UploadWizard open={uploadOpen} onOpenChange={setUploadOpen} />
    </div>
  );
}
