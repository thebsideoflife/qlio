import { Activity, FileCode, Maximize2, LogOut, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModeToggle } from "@/components/mode-toggle";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Link, useLocation, useNavigate } from "react-router-dom";
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
import { useState } from "react";

interface MainLayoutProps {
  children: React.ReactNode;
}

export function MainLayout({ children }: MainLayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const isEditorPage = location.pathname === "/editor";
  const [isPasswordOpen, setIsPasswordOpen] = useState(false);
  const [newPassword, setNewPassword] = useState("");

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

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Avatar className="h-8 w-8 cursor-pointer">
                <AvatarImage src="/placeholder-user.jpg" alt="User" />
                <AvatarFallback>U</AvatarFallback>
              </Avatar>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>My Account</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setIsPasswordOpen(true)}>
                <KeyRound className="mr-2 h-4 w-4" />
                Edit API Password
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleLogout} className="text-red-600">
                <LogOut className="mr-2 h-4 w-4" />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <main className="flex-1 overflow-auto p-8">{children}</main>

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
    </div>
  );
}
