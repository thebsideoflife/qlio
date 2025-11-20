import { Activity, Bell, Settings, FileCode, Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModeToggle } from "@/components/mode-toggle";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Link, useLocation } from "react-router-dom";

interface MainLayoutProps {
  children: React.ReactNode;
}

export function MainLayout({ children }: MainLayoutProps) {
  const location = useLocation();
  const isEditorPage = location.pathname === "/editor";

  return (
    <div className="flex h-screen w-full flex-col bg-background text-foreground overflow-hidden">
      <header className="flex h-16 items-center justify-between border-b px-8 bg-card gap-6">
        <Link
          to="/"
          className="flex items-center gap-3 font-semibold hover:opacity-80 transition-opacity"
        >
          <div className="rounded bg-primary p-2">
            <Activity className="h-5 w-5 text-primary-foreground" />
          </div>
          <span className="text-xl">ZeeVee</span>
        </Link>

        {/* Editor page info and actions in header */}
        {isEditorPage && (
          <>
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <h1 className="text-sm font-semibold">Segment Editor</h1>
                <div className="text-xs text-muted-foreground flex gap-2 justify-center">
                  <span>Star Trek: The Next Generation S07E25</span>
                  <span>•</span>
                  <span>44:00 Runtime</span>
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm">
                <FileCode className="h-4 w-4 mr-2" />
                Export EDL
              </Button>
              <Button size="sm" className="bg-blue-600 hover:bg-blue-700">
                <Maximize2 className="h-4 w-4 mr-2" />
                Render Segments
              </Button>
            </div>
          </>
        )}

        <div className="flex items-center gap-4">
          <ModeToggle />
          <Button variant="ghost" size="icon">
            <Bell className="h-5 w-5" />
          </Button>
          <Button variant="ghost" size="icon">
            <Settings className="h-5 w-5" />
          </Button>
          <Avatar className="h-8 w-8 cursor-pointer">
            <AvatarImage src="/placeholder-user.jpg" alt="User" />
            <AvatarFallback>JD</AvatarFallback>
          </Avatar>
        </div>
      </header>
      <main className="flex-1 overflow-auto p-8">{children}</main>
    </div>
  );
}
