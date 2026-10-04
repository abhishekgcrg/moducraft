const pillars = [
  ["ModuCraft IDE", "Describe an idea, plan it with AI agents, build, test, and prepare it for deployment."],
  ["ModuCraft Cloud", "Manage projects, databases, object storage, deployments, logs, and configuration."],
  ["ModuCraft Marketplace", "Discover reusable templates and components with license and security review."],
];

export default function Home() {
  return (
    <main className="shell">
      <nav className="nav">
        <div className="brand"><span className="mark">M</span> ModuCraft</div>
        <span className="phase">FOUNDATION · PHASE 1</span>
      </nav>
      <section className="hero">
        <p className="eyebrow">BUILD · OWN · DEPLOY</p>
        <h1>Your ideas.<br /><span>Your infrastructure.</span></h1>
        <p className="intro">
          A self-hostable platform where AI agents help you create software,
          while you stay in control of your code, data, and deployment.
        </p>
        <div className="status"><span className="dot" /> Foundation scaffold initialized</div>
      </section>
      <section className="grid">
        {pillars.map(([title, description]) => (
          <article className="card" key={title}>
            <div className="cardIcon">{title === "ModuCraft IDE" ? "⌘" : title === "ModuCraft Cloud" ? "◈" : "▦"}</div>
            <h2>{title}</h2>
            <p>{description}</p>
          </article>
        ))}
      </section>
      <footer>Open-source first. Self-hostable by design. Not production-ready yet.</footer>
    </main>
  );
}
