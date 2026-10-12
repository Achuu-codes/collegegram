/**
 * The single place the frontend talks to the API.
 *
 * TOKEN STORAGE — the one security decision that matters on this side.
 *   The access token is held in a module-scoped variable: in memory only, never
 *   in localStorage. Anything in localStorage is readable by any JavaScript on
 *   the page, so a single XSS — in our code or in any dependency — hands an
 *   attacker a working credential. In memory, the token dies with the tab.
 *
 *   The cost is that a refresh of the page loses the access token, which is
 *   exactly what the refresh cookie is for: it is httpOnly (invisible to JS),
 *   SameSite=Strict, scoped to /auth, and `restore()` below trades it for a new
 *   access token on load. So the long-lived credential is the one JavaScript
 *   cannot touch, and the one JavaScript holds expires in 15 minutes.
 *
 * `credentials: "include"` is required for that cookie to be sent at all on a
 * cross-origin request (:5173 → :5050), and it is why the server's CORS config
 * must name an explicit origin rather than reflecting any.
 */
const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:5050";

let accessToken = null;

export const getToken = () => accessToken;
export const setToken = (token) => {
  accessToken = token;
};

class ApiError extends Error {
  constructor({ code, message, details }) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

async function request(path, { method = "GET", body, retry = true } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    credentials: "include",
    headers: {
      ...(body && { "Content-Type": "application/json" }),
      ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
    },
    ...(body && { body: JSON.stringify(body) }),
  });

  if (response.status === 204) return null;

  const payload = await response.json().catch(() => ({}));

  /**
   * Transparent refresh-and-retry. An expired access token is a routine event
   * (every 15 minutes), not an error the user should ever see: we spend the
   * refresh cookie for a new token and replay the request exactly once.
   *
   * `retry: false` on the replay is what prevents an infinite loop when the
   * refresh itself is what failed.
   */
  if (response.status === 401 && retry && payload?.error?.code === "TOKEN_EXPIRED") {
    const refreshed = await restore();
    if (refreshed) return request(path, { method, body, retry: false });
  }

  if (!response.ok) throw new ApiError(payload.error ?? { message: "Request failed" });
  return payload.data;
}

/** Trade the refresh cookie for a new access token. Returns the user, or null. */
export async function restore() {
  try {
    const data = await request("/auth/refresh", { method: "POST", retry: false });
    setToken(data.accessToken);
    return data.user;
  } catch {
    setToken(null);
    return null;
  }
}

export const api = {
  register: (body) => request("/auth/register", { method: "POST", body }),
  login: (body) => request("/auth/login", { method: "POST", body }),
  logout: () => request("/auth/logout", { method: "POST" }),
  me: () => request("/auth/me"),
  feed: ({ sort = "new", cursor, college } = {}) =>
    request(
      `/posts?sort=${sort}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}${
        college ? `&college=${encodeURIComponent(college)}` : ""
      }`
    ),
  createPost: (body) => request("/posts", { method: "POST", body }),
  deletePost: (id) => request(`/posts/${id}`, { method: "DELETE" }),
  vote: (id, value) => request(`/posts/${id}/vote`, { method: "POST", body: { value } }),
  comments: (id) => request(`/posts/${id}/comments`),
  comment: (id, body) => request(`/posts/${id}/comments`, { method: "POST", body: { body } }),
};

export { ApiError };
