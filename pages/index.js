export default function Home() {
  return (
    <main style={{ padding: "2rem", fontFamily: "sans-serif" }}>
      <h1>Dialect Data - Annotation Workspace</h1>
      <p>Welcome to the Dialect Data platform.</p>
      <p>
        You can access the Stage 2 Annotation UI here:{" "}
        <a href="/stage2?debug=1">Stage 2 (Debug Mode)</a>
      </p>
      <p>
        API manifest available at <a href="/api/tasks">/api/tasks</a>
      </p>
    </main>
  );
}
