import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Provider } from "react-redux";
import { store } from "./store/store";
import { TooltipProvider } from "./components/ui/tooltip";
import { MainLayout } from "./components/layout/MainLayout";
import Dashboard from "./pages/Dashboard";
import Editor from "./pages/Editor";
import Export from "./pages/Export";
import SignIn from "./pages/SignIn";
import { RequireAuth } from "./components/RequireAuth";

function App() {
  return (
    <Provider store={store}>
      <TooltipProvider>
        <BrowserRouter>
        <Routes>
          <Route path="/signin" element={<SignIn />} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <MainLayout>
                  <Dashboard />
                </MainLayout>
              </RequireAuth>
            }
          />
          <Route
            path="/editor/:projectId"
            element={
              <RequireAuth>
                <MainLayout>
                  <Editor />
                </MainLayout>
              </RequireAuth>
            }
          />
          <Route
            path="/editor/:projectId/export"
            element={
              <RequireAuth>
                <MainLayout>
                  <Export />
                </MainLayout>
              </RequireAuth>
            }
          />
        </Routes>
        </BrowserRouter>
      </TooltipProvider>
    </Provider>
  );
}

export default App;
