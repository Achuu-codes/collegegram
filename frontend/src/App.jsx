/**
 * CollegeGram client — deliberately small.
 *
 * The backend is the subject of this project; this is a functional client that
 * exercises every endpoint end to end (register, login, restore-on-reload,
 * feed, post, vote, comment, delete, logout) and nothing more. No router, no
 * state library, no component library: four screens' worth of state is not a
 * Redux problem, and adding one would be the kind of unjustified abstraction
 * the project set out to avoid.
 */
import { useCallback, useEffect, useState } from "react";
import { api, setToken, restore } from "./api.js";
import "./App.css";

export default function App() {
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(true);
  const [feed, setFeed] = useState({ items: [], nextCursor: null });
  const [sort, setSort] = useState("new");
  const [error, setError] = useState(null);

  // On load there is no access token in memory (by design — see api.js), so we
  // spend the httpOnly refresh cookie to get one. This is what makes a page
  // refresh keep you signed in without ever putting a credential in storage.
  useEffect(() => {
    restore()
      .then(setUser)
      .finally(() => setBooting(false));
  }, []);

  const loadFeed = useCallback(
    async (nextSort = sort) => {
      try {
        setFeed(await api.feed({ sort: nextSort }));
        setError(null);
      } catch (err) {
        setError(err.message);
      }
    },
    [sort]
  );

  useEffect(() => {
    if (user) loadFeed();
  }, [user, loadFeed]);

  async function loadMore() {
    if (!feed.nextCursor) return;
    const next = await api.feed({ sort, cursor: feed.nextCursor });
    // Append, never replace: cursor pages are stable, so this cannot duplicate.
    setFeed({ items: [...feed.items, ...next.items], nextCursor: next.nextCursor });
  }

  async function onVote(post, value) {
    // Send 0 to retract when the button already reflects my vote — the same
    // endpoint handles cast, change and remove.
    const intended = post.myVote === value ? 0 : value;
    try {
      const result = await api.vote(post.id, intended);
      setFeed((current) => ({
        ...current,
        items: current.items.map((p) =>
          p.id === post.id ? { ...p, score: result.score, myVote: result.myVote } : p
        ),
      }));
    } catch (err) {
      setError(err.message);
    }
  }

  async function onLogout() {
    await api.logout();
    setToken(null);
    setUser(null);
    setFeed({ items: [], nextCursor: null });
  }

  if (booting) return <main className="shell"><p className="muted">Loading…</p></main>;

  if (!user) return <Auth onAuthenticated={setUser} />;

  return (
    <main className="shell">
      <header className="bar">
        <h1>CollegeGram</h1>
        <div className="bar-right">
          <span className="muted">
            {user.displayName} · {user.collegeDomain}
          </span>
          <button onClick={onLogout}>Sign out</button>
        </div>
      </header>

      {error && <p className="error">{error}</p>}

      <Composer onPosted={() => loadFeed()} onError={setError} />

      <nav className="tabs">
        {["new", "top"].map((option) => (
          <button
            key={option}
            className={sort === option ? "tab active" : "tab"}
            onClick={() => {
              setSort(option);
              loadFeed(option);
            }}
          >
            {option === "new" ? "Newest" : "Top"}
          </button>
        ))}
      </nav>

      {feed.items.length === 0 && <p className="muted">No posts in your college yet.</p>}

      <ul className="posts">
        {feed.items.map((post) => (
          <PostCard
            key={post.id}
            post={post}
            viewer={user}
            onVote={onVote}
            onDeleted={() => loadFeed()}
            onError={setError}
          />
        ))}
      </ul>

      {feed.nextCursor && (
        <button className="more" onClick={loadMore}>
          Load more
        </button>
      )}
    </main>
  );
}

function Auth({ onAuthenticated }) {
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({
    identifier: "",
    email: "",
    username: "",
    displayName: "",
    password: "",
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const field = (name) => ({
    value: form[name],
    onChange: (event) => setForm({ ...form, [name]: event.target.value }),
  });

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data =
        mode === "login"
          ? await api.login({ identifier: form.identifier, password: form.password })
          : await api.register({
              email: form.email,
              username: form.username,
              displayName: form.displayName,
              password: form.password,
            });
      setToken(data.accessToken);
      onAuthenticated(data.user);
    } catch (err) {
      // The server returns field-level details for a validation failure; show
      // them rather than a generic "something went wrong".
      setError(err.details?.map((d) => `${d.field}: ${d.message}`).join("\n") ?? err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell narrow">
      <h1>CollegeGram</h1>
      <p className="muted">Sign in with your college email.</p>

      <form onSubmit={submit} className="card">
        {mode === "login" ? (
          <input placeholder="Email or username" autoComplete="username" required {...field("identifier")} />
        ) : (
          <>
            <input type="email" placeholder="you@college.edu" required {...field("email")} />
            <input placeholder="username" required {...field("username")} />
            <input placeholder="Display name" required {...field("displayName")} />
          </>
        )}
        <input
          type="password"
          placeholder="Password (10+ characters)"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          required
          {...field("password")}
        />

        {error && <p className="error">{error}</p>}

        <button type="submit" disabled={busy}>
          {busy ? "…" : mode === "login" ? "Sign in" : "Create account"}
        </button>
        <button
          type="button"
          className="link"
          onClick={() => {
            setMode(mode === "login" ? "register" : "login");
            setError(null);
          }}
        >
          {mode === "login" ? "Need an account?" : "Already have one?"}
        </button>
      </form>
    </main>
  );
}

function Composer({ onPosted, onError }) {
  const [form, setForm] = useState({ title: "", body: "" });
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    try {
      await api.createPost(form);
      setForm({ title: "", body: "" });
      onPosted();
    } catch (err) {
      onError(err.details?.[0]?.message ?? err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card">
      <input
        placeholder="Title"
        value={form.title}
        onChange={(e) => setForm({ ...form, title: e.target.value })}
        required
      />
      <textarea
        placeholder="Say something…"
        rows={3}
        value={form.body}
        onChange={(e) => setForm({ ...form, body: e.target.value })}
        required
      />
      <button type="submit" disabled={busy}>
        {busy ? "Posting…" : "Post"}
      </button>
    </form>
  );
}

function PostCard({ post, viewer, onVote, onDeleted, onError }) {
  const [comments, setComments] = useState(null);
  const [draft, setDraft] = useState("");

  async function toggleComments() {
    if (comments) return setComments(null);
    try {
      setComments((await api.comments(post.id)).items);
    } catch (err) {
      onError(err.message);
    }
  }

  async function addComment(event) {
    event.preventDefault();
    try {
      const { comment } = await api.comment(post.id, draft);
      setComments([comment, ...(comments ?? [])]);
      setDraft("");
    } catch (err) {
      onError(err.details?.[0]?.message ?? err.message);
    }
  }

  const mine = post.author?.id === viewer.id;

  return (
    <li className="post">
      <div className="votes">
        <button className={post.myVote === 1 ? "voted" : ""} onClick={() => onVote(post, 1)}>
          ▲
        </button>
        <strong>{post.score}</strong>
        <button className={post.myVote === -1 ? "voted" : ""} onClick={() => onVote(post, -1)}>
          ▼
        </button>
      </div>

      <div className="post-main">
        <h3>{post.title}</h3>
        <p>{post.body}</p>
        <p className="muted small">
          {post.author?.displayName ?? "unknown"} · {new Date(post.createdAt).toLocaleString()}
          {" · "}
          <button className="link" onClick={toggleComments}>
            {post.commentCount} comments
          </button>
          {mine && (
            <>
              {" · "}
              <button
                className="link danger"
                onClick={() => api.deletePost(post.id).then(onDeleted).catch((e) => onError(e.message))}
              >
                delete
              </button>
            </>
          )}
        </p>

        {comments && (
          <div className="comments">
            <form onSubmit={addComment}>
              <input
                placeholder="Add a comment"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                required
              />
              <button type="submit">Reply</button>
            </form>
            {comments.map((comment) => (
              <p key={comment.id} className="comment">
                <strong>{comment.author?.username ?? "unknown"}</strong> {comment.body}
              </p>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}
