import { createRoot } from "react-dom/client";
import "./styles.css";
import { StagePage } from "./stage/StagePage";
import { AdminPage } from "./admin/AdminPage";

function App() {
  const path = location.pathname;
  if (path.startsWith("/admin")) return <AdminPage />;
  if (path.startsWith("/stage")) return <StagePage />;
  return (
    <div className="landing">
      <h1>Lootbot</h1>
      <p>
        <a href="/admin">Admin page</a> · <a href="/stage">Stage screen</a>
      </p>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
