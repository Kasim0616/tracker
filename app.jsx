const { useState, useMemo, useCallback, useRef, useEffect } = React;
const API_BASE = window.BACKEND_URL || "http://127.0.0.1:8000";
const PROFILE_KEY = "tracker_profile_v1";
const ADMIN_LOGIN = { name: "trackeradmin", password: "9087700234" };

const STATUS_CONFIG = [
    { id: "wishlist", label: "Wishlist", blurb: "Roles you're researching or prepping" },
    { id: "applied", label: "Applied", blurb: "Applications submitted and awaiting updates" },
    { id: "interview", label: "Interview", blurb: "Phone screens, onsites, or challenges" },
    { id: "offer", label: "Offer", blurb: "Offers extended or in negotiation" },
    { id: "rejected", label: "Rejected", blurb: "Closed opportunities & feedback" }
];

const STATUS_ACCENTS = {
    wishlist: "#a855f7",
    applied: "#4f46e5",
    interview: "#0ea5e9",
    offer: "#22c55e",
    rejected: "#ef4444"
};

const defaultStatusId = "applied";
const FILTER_DEFAULTS = { status: "all", text: "" };
const timelineStatuses = ["wishlist", "applied", "interview"];
const timelineDays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const fallbackTimeline = [
    { day: "Mon", wishlist: 2, applied: 1, interview: 0 },
    { day: "Tue", wishlist: 3, applied: 2, interview: 1 },
    { day: "Wed", wishlist: 4, applied: 3, interview: 1 },
    { day: "Thu", wishlist: 3, applied: 2, interview: 2 },
    { day: "Fri", wishlist: 2, applied: 3, interview: 2 },
    { day: "Sat", wishlist: 1, applied: 1, interview: 1 },
    { day: "Sun", wishlist: 1, applied: 2, interview: 0 }
];
const badgePalette = ["#6366f1", "#f97316", "#ec4899", "#22c55e", "#14b8a6", "#a855f7"];


function createEmptyForm() {
    return {
        company: "",
        role: "",
        link: "",
        date: "",
        status: defaultStatusId,
        location: "",
        notes: ""
    };
}

function loadProfile() {
    try {
        const stored = localStorage.getItem(PROFILE_KEY);
        if (!stored) return null;
        const parsed = JSON.parse(stored);
        if (!parsed?.name || !parsed?.token) return null;
        return parsed;
    } catch (err) {
        console.warn("Could not read profile from storage", err);
        return null;
    }
}

function persistProfile(profile) {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
}

function clearProfile() {
    localStorage.removeItem(PROFILE_KEY);
}

function App() {
    const [profile, setProfile] = useState(() => loadProfile());
    const [applications, setApplications] = useState([]);
    const [filters, setFilters] = useState(() => ({ ...FILTER_DEFAULTS }));
    const [formData, setFormData] = useState(() => createEmptyForm());
    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState("");
    const [authError, setAuthError] = useState("");
    const [timelineView, setTimelineView] = useState("Day");
    const [adminToken, setAdminToken] = useState("");
    const [adminUsers, setAdminUsers] = useState([]);
    const [adminEvents, setAdminEvents] = useState([]);
    const [adminError, setAdminError] = useState("");
    const [adminLoading, setAdminLoading] = useState(false);
    const [adminAuthenticated, setAdminAuthenticated] = useState(false);
    const [adminAuthError, setAdminAuthError] = useState("");
    const [adminForm, setAdminForm] = useState({ name: "", location: "", pin: "" });
    const [portal, setPortal] = useState("user"); // "user" or "admin"
    const formSectionRef = useRef(null);

    const buildUrl = useCallback(
        (path, options = {}) => {
            const { includeOwner = false, extraQuery = "" } = options;
            const normalized = path.startsWith("/") ? path : `/${path}`;
            const queryParts = [];
            if (extraQuery) queryParts.push(extraQuery);
            if (includeOwner && profile?.name) queryParts.push(`owner=${encodeURIComponent(profile.name)}`);
            const query = queryParts.filter(Boolean).join("&");
            return `${API_BASE}${normalized}${query ? `?${query}` : ""}`;
        },
        [profile?.name]
    );

    const authHeaders = useMemo(() => {
        return profile?.token ? { "X-User-Token": profile.token } : {};
    }, [profile?.token]);

    const handleProfileSubmit = async (nextProfile) => {
        setIsSaving(true);
        setAuthError("");
        try {
            const response = await fetch(buildUrl("/api/auth/login", { includeOwner: false }), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(nextProfile)
            });
            if (!response.ok) {
                const body = await response.text();
                throw new Error(body || `Login failed with ${response.status}`);
            }
            const data = await response.json();
            persistProfile(data);
            setProfile(data);
            setError("");
        } catch (err) {
            console.error("Login failed", err);
            setAuthError("Login failed. Check your name and access code, or ask admin to create your account.");
        } finally {
            setIsSaving(false);
        }
    };

    const handleAdminLogin = async (credentials) => {
        const name = (credentials?.name || "").trim().toLowerCase();
        const password = (credentials?.password || "").trim();
        if (name !== ADMIN_LOGIN.name || !password) {
            setAdminAuthenticated(false);
            setAdminToken("");
            setAdminAuthError("Admin login failed. Check the admin name and token.");
            return false;
        }
        const didLoad = await loadAdminData(password);
        if (didLoad) {
            setAdminAuthenticated(true);
            setAdminToken(password);
            setAdminAuthError("");
            setAdminError("");
            return true;
        }
        setAdminAuthenticated(false);
        setAdminToken("");
        setAdminAuthError("Admin login failed. Check the admin name and token.");
        return false;
    };

    const handleAdminLogout = () => {
        setAdminAuthenticated(false);
        setAdminToken("");
        setAdminUsers([]);
        setAdminEvents([]);
        setAdminError("");
        setAdminAuthError("");
    };

    const handleLogout = (options = { clearAuth: true }) => {
        clearProfile();
        setProfile(null);
        setApplications([]);
        setAdminUsers([]);
        setAdminEvents([]);
        if (options.clearAuth) {
            setAuthError("");
        }
    };

    const switchPortal = (nextPortal) => {
        if (nextPortal === portal) return;
        handleLogout({ clearAuth: true });
        handleAdminLogout();
        setPortal(nextPortal);
        setAdminError("");
        setAdminAuthError("");
    };

    const ensureSession = () => {
        if (!profile?.token) {
            handleLogout({ clearAuth: false });
            setAuthError("Session expired. Please sign in again.");
            return false;
        }
        return true;
    };

    const loadAdminData = async (tokenOverride) => {
        const tokenToUse = tokenOverride || adminToken;
        if ((!adminAuthenticated && !tokenOverride) || !tokenToUse) {
            setAdminError("Admin login required.");
            return false;
        }
        setAdminLoading(true);
        setAdminError("");
        try {
            const headers = { "X-Admin-Token": tokenToUse };
            const usersResponse = await fetch(buildUrl("/api/admin/users", { includeOwner: false }), { headers });
            if (!usersResponse.ok) {
                throw new Error(`Users fetch failed with ${usersResponse.status}`);
            }
            const users = await usersResponse.json();

            const eventsResponse = await fetch(
                buildUrl("/api/admin/events", { includeOwner: false, extraQuery: "limit=1000" }),
                { headers }
            );
            if (!eventsResponse.ok) {
                throw new Error(`Events fetch failed with ${eventsResponse.status}`);
            }
            const events = await eventsResponse.json();

            setAdminUsers(users.users || []);
            setAdminEvents(events.events || []);
            return true;
        } catch (err) {
            console.error("Admin load failed", err);
            setAdminError("Could not load admin data. Check token and backend.");
            setAdminUsers([]);
            setAdminEvents([]);
            return false;
        } finally {
            setAdminLoading(false);
        }
    };

    const handleAdminUserSave = async () => {
        if (!adminAuthenticated || !adminToken) {
            setAdminError("Admin login required.");
            return;
        }
        if (!adminForm.name.trim() || !adminForm.pin.trim()) {
            setAdminError("Name and access code are required.");
            return;
        }
        setAdminLoading(true);
        setAdminError("");
        try {
            const response = await fetch(buildUrl("/api/admin/users", { includeOwner: false }), {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-Admin-Token": adminToken },
                body: JSON.stringify({
                    name: adminForm.name.trim(),
                    location: adminForm.location.trim(),
                    pin: adminForm.pin.trim()
                })
            });
            if (!response.ok) {
                const body = await response.text();
                const message = body || `Admin save failed with ${response.status}`;
                throw new Error(message);
            }
            setAdminForm({ name: "", location: "", pin: "" });
            await loadAdminData();
        } catch (err) {
            console.error("Admin user save failed", err);
            setAdminError(err?.message || "Could not save user. Check token and details.");
        } finally {
            setAdminLoading(false);
        }
    };

    const handleAdminUserRemove = async (name) => {
        if (!adminAuthenticated || !adminToken) {
            setAdminError("Admin login required.");
            return;
        }
        if (!name) return;
        setAdminLoading(true);
        setAdminError("");
        try {
            const response = await fetch(buildUrl(`/api/admin/users?name=${encodeURIComponent(name)}`, { includeOwner: false }), {
                method: "DELETE",
                headers: { "X-Admin-Token": adminToken }
            });
            if (!response.ok && response.status !== 204) {
                const body = await response.text();
                throw new Error(body || `Admin delete failed with ${response.status}`);
            }
            await loadAdminData();
        } catch (err) {
            console.error("Admin user delete failed", err);
            setAdminError("Could not remove user. Check token and details.");
        } finally {
            setAdminLoading(false);
        }
    };

    useEffect(() => {
        if (!profile?.name || !profile?.token) {
            setApplications([]);
            setIsLoading(false);
            return;
        }
        let isCancelled = false;
        const fetchApplications = async () => {
            setIsLoading(true);
            setError("");
            try {
                const response = await fetch(buildUrl("/api/applications"), { headers: authHeaders });
                if (!response.ok) {
                    throw new Error(`Backend responded with ${response.status}`);
                }
                const data = await response.json();
                if (!isCancelled) {
                    setApplications(data.items || []);
                }
            } catch (err) {
                console.error("Failed to load applications", err);
                if (!isCancelled) {
                    setError("Unable to reach backend. Please try again.");
                }
            } finally {
                if (!isCancelled) setIsLoading(false);
            }
        };
        fetchApplications();
        return () => {
            isCancelled = true;
        };
    }, [profile?.name, profile?.token, authHeaders, buildUrl]);

    const statusCounts = useMemo(() => {
        const counts = {};
        STATUS_CONFIG.forEach((status) => {
            counts[status.id] = 0;
        });
        applications.forEach((app) => {
            counts[app.status] = (counts[app.status] || 0) + 1;
        });
        return counts;
    }, [applications]);

    const stats = useMemo(
        () => ({
            total: applications.length,
            interview: statusCounts.interview || 0,
            offer: statusCounts.offer || 0,
            rejection: statusCounts.rejected || 0
        }),
        [applications.length, statusCounts]
    );

    const applyFilters = useCallback(
        (app) => {
            if (filters.status !== "all" && app.status !== filters.status) {
                return false;
            }
            if (filters.text) {
                const haystack = `${app.company} ${app.role} ${app.location ?? ""} ${app.notes ?? ""}`.toLowerCase();
                if (!haystack.includes(filters.text.toLowerCase())) {
                    return false;
                }
            }
            return true;
        },
        [filters]
    );

    const boardColumns = useMemo(
        () =>
            STATUS_CONFIG.map((status) => ({
                status,
                entries: applications.filter((app) => app.status === status.id).filter(applyFilters)
            })),
        [applications, applyFilters]
    );

    const timelineData = useMemo(() => buildTimelineData(applications), [applications]);
    const upcoming = useMemo(() => buildUpcomingDeadlines(applications), [applications]);
    const progressRatio = stats.total ? Math.min(1, (stats.offer + stats.interview) / stats.total) : 0;

    const handleFormChange = (event) => {
        const { name, value } = event.target;
        setFormData((prev) => ({ ...prev, [name]: value }));
    };

    const handleFormSubmit = async (event) => {
        event.preventDefault();
        const payload = {
            company: formData.company.trim(),
            role: formData.role.trim(),
            link: formData.link.trim(),
            date: formData.date,
            status: formData.status || defaultStatusId,
            location: formData.location.trim(),
            notes: formData.notes.trim()
        };
        if (!payload.company || !payload.role) return;

        if (!ensureSession()) return;
        setIsSaving(true);
        try {
            const response = await fetch(buildUrl("/api/applications"), {
                method: "POST",
                headers: { "Content-Type": "application/json", ...authHeaders },
                body: JSON.stringify(payload)
            });
            if (!response.ok) {
                const body = await response.text();
                throw new Error(body || `POST failed with ${response.status}`);
            }
            const created = await response.json();
            setApplications((prev) => [created, ...prev]);
            setFormData(createEmptyForm());
        } catch (err) {
            console.error("Create failed", err);
            alert("Could not save application. Ensure backend is running.");
        } finally {
            setIsSaving(false);
        }
    };

    const handleResetForm = () => {
        setFormData(createEmptyForm());
    };

    const updateApplication = async (id, updates) => {
        if (!ensureSession()) return;
        try {
            const response = await fetch(buildUrl(`/api/applications/${id}`), {
                method: "PUT",
                headers: { "Content-Type": "application/json", ...authHeaders },
                body: JSON.stringify(updates)
            });
            if (!response.ok) {
                const body = await response.text();
                throw new Error(body || `PUT failed with ${response.status}`);
            }
            const updated = await response.json();
            setApplications((prev) => prev.map((app) => (app.id === id ? updated : app)));
        } catch (err) {
            console.error("Update failed", err);
            alert("Could not update application. Ensure backend is running.");
        }
    };

    const handleReject = (id) => updateApplication(id, { status: "rejected" });
    const handleAdvance = (id, nextStatusId) => {
        if (!nextStatusId) return;
        updateApplication(id, { status: nextStatusId });
    };
    const handleDelete = async (id) => {
        if (!ensureSession()) return;
        try {
            const response = await fetch(buildUrl(`/api/applications/${id}`), {
                method: "DELETE",
                headers: { ...authHeaders }
            });
            if (response.status === 204) {
                setApplications((prev) => prev.filter((app) => app.id !== id));
                return;
            }
            if (response.status === 404) {
                setApplications((prev) => prev.filter((app) => app.id !== id));
                return;
            }
            const body = await response.text();
            throw new Error(body || `DELETE failed with ${response.status}`);
        } catch (err) {
            console.error("Delete failed", err);
            alert("Could not delete application. Ensure backend is running.");
        }
    };

    const handleFilterChange = (key, value) => {
        setFilters((prev) => ({ ...prev, [key]: value }));
    };

    const clearFilters = () => setFilters({ ...FILTER_DEFAULTS });

    const scrollToForm = () => {
        formSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    };

    if (portal === "admin") {
        return (
            <AdminPortal
                adminAuthenticated={adminAuthenticated}
                adminAuthError={adminAuthError}
                onAdminLogin={handleAdminLogin}
                onAdminLogout={handleAdminLogout}
                onClearAdminAuthError={() => setAdminAuthError("")}
                adminForm={adminForm}
                setAdminForm={setAdminForm}
                adminLoading={adminLoading}
                adminError={adminError}
                adminUsers={adminUsers}
                adminEvents={adminEvents}
                onLoadAdminData={loadAdminData}
                onSaveAdminUser={handleAdminUserSave}
                onRemoveAdminUser={handleAdminUserRemove}
                onClearEvents={async () => {
                    if (!adminToken || !adminAuthenticated) {
                        setAdminError("Admin login required.");
                        return;
                    }
                    setAdminLoading(true);
                    setAdminError("");
                    try {
                        const response = await fetch(buildUrl("/api/admin/events/clear", { includeOwner: false }), {
                            method: "DELETE",
                            headers: { "X-Admin-Token": adminToken }
                        });
                        if (!response.ok && response.status !== 204) {
                            const body = await response.text();
                            throw new Error(body || `Clear failed with ${response.status}`);
                        }
                        await loadAdminData();
                    } catch (err) {
                        console.error("Clear events failed", err);
                        setAdminError(err?.message || "Could not clear events. Check token and backend.");
                    } finally {
                        setAdminLoading(false);
                    }
                }}
                onSwitchPortal={() => switchPortal("user")}
            />
        );
    }

    if (!profile) {
        return (
            <LoginScreen
                onSubmit={handleProfileSubmit}
                isSaving={isSaving}
                errorMessage={authError}
                onSwitchPortal={() => switchPortal("admin")}
            />
        );
    }

    return (
        <div className="dashboard">
            <div className="main-layout">
                <div className="center-column">
                    <section className="card hero">
                        <div>
                            <p className="hero__subtitle">Hello {profile.name || "there"}</p>
                            <h1 className="hero__title">Your job-hunt mission control</h1>
                            <p className="hero__subtitle">
                                Track applications, monitor interviews, and capture insights without the spreadsheet chaos.
                            </p>
                        </div>
                        <div className="hero-actions">
                            <button className="primary-btn" type="button" onClick={scrollToForm}>
                                + New application
                            </button>
                        </div>
                    </section>

                    <section className="card">
                        <div className="section-heading">
                            <h2>Pipeline highlights</h2>
                            <span>{stats.total} tracked roles</span>
                        </div>
                        <StatsRow statusCounts={statusCounts} total={stats.total} />
                    </section>

                    <section className="card timeline-card">
                        <div className="section-heading">
                            <h2>Activity timeline</h2>
                            <div className="timeline-tabs">
                                {"Day Week Month Year".split(" ").map((label) => (
                                    <button
                                        key={label}
                                        type="button"
                                        className={label === timelineView ? "is-active" : ""}
                                        onClick={() => setTimelineView(label)}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <TimelineChart data={timelineData} />
                    </section>

                    <section className="card board-panel">
                        <div className="section-heading">
                            <h2>Kanban board</h2>
                            <span>Drag-free statuses with instant actions</span>
                        </div>
                        {isLoading ? (
                            <div className="empty-state">Loading applications...</div>
                        ) : error ? (
                            <div className="empty-state">{error}</div>
                        ) : null}
                        <KanbanBoard
                            columns={boardColumns}
                            filters={filters}
                            onChangeStatus={(id, status) => updateApplication(id, { status })}
                            onAdvance={handleAdvance}
                            onReject={handleReject}
                            onDelete={handleDelete}
                        />
                    </section>
                    <section className="card form-card" id="application-form-card" ref={formSectionRef}>
                        <div className="section-heading">
                            <h2>Add or update an application</h2>
                            <span>Document the details for quick reference</span>
                        </div>
                        <form onSubmit={handleFormSubmit}>
                            <div className="form-grid">
                                <label>
                                    Company name
                                    <input
                                        className="input-control"
                                        type="text"
                                        name="company"
                                        placeholder="Acme Robotics"
                                        required
                                        value={formData.company}
                                        onChange={handleFormChange}
                                    />
                                </label>
                                <label>
                                    Role / title
                                    <input
                                        className="input-control"
                                        type="text"
                                        name="role"
                                        placeholder="Product Designer II"
                                        required
                                        value={formData.role}
                                        onChange={handleFormChange}
                                    />
                                </label>
                                <label>
                                    Application link
                                    <input
                                        className="input-control"
                                        type="url"
                                        name="link"
                                        placeholder="https://careers.example.com/job"
                                        value={formData.link}
                                        onChange={handleFormChange}
                                    />
                                </label>
                                <label>
                                    Applied date
                                    <input
                                        className="input-control"
                                        type="date"
                                        name="date"
                                        value={formData.date}
                                        onChange={handleFormChange}
                                    />
                                </label>
                                <label>
                                    Status
                                    <select
                                        className="select-control"
                                        name="status"
                                        value={formData.status}
                                        onChange={handleFormChange}
                                    >
                                        {STATUS_CONFIG.map((status) => (
                                            <option key={status.id} value={status.id}>
                                                {status.label}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <label>
                                    Location
                                    <input
                                        className="input-control"
                                        type="text"
                                        name="location"
                                        placeholder="Remote / NYC / Berlin"
                                        value={formData.location}
                                        onChange={handleFormChange}
                                    />
                                </label>
                            </div>
                            <label>
                                Notes, feedback, or next step
                                <textarea
                                    name="notes"
                                    className="input-control"
                                    placeholder="Interview scheduled, feedback from recruiter, next reminder..."
                                    value={formData.notes}
                                    onChange={handleFormChange}
                                ></textarea>
                            </label>
                            <div className="form-actions">
                                <button className="primary-btn" type="submit">
                                    Save application
                                </button>
                    
                            </div>
                        </form>
                    </section>
                </div>

                <div className="right-rail">
                    <section className="card profile-card">
                        <div className="avatar">{getInitials(profile.name || "") || "?"}</div>
                        <div>
                            <strong style={{ display: "block" }}>{profile.name || "Welcome"}</strong>
                            <p style={{ margin: "0.2rem 0", color: "#94a3b8" }}>
                                {profile.location || "Add your location"}
                            </p>
                            <small style={{ color: "#6366f1", fontWeight: 600 }}>{stats.total} total opportunities</small>
                            <div style={{ marginTop: "0.4rem" }}>
                                <button className="pill-btn" type="button" onClick={() => handleLogout()}>
                                    Log out
                                </button>
                            </div>
                        </div>
                    </section>

                    <section className="card progress-card">
                        <div className="section-heading">
                            <h2>Overall progress</h2>
                            <span>Day / Week / Month</span>
                        </div>
                        <ProgressDonut ratio={progressRatio} />
                        <p style={{ color: "#475569", marginTop: "1rem" }}>
                            {stats.offer} offers | {stats.interview} interviews | {stats.rejection} rejections
                        </p>
                    </section>

                    <section className="card">
                        <div className="section-heading">
                            <h2>Quick filters</h2>
                            <button className="pill-btn" type="button" onClick={clearFilters}>
                                Reset
                            </button>
                        </div>
                        <FiltersPanel filters={filters} onChange={handleFilterChange} />
                    </section>

                    <section className="card">
                        <div className="section-heading">
                            <h2>Upcoming checkpoints</h2>
                            <span>{upcoming.length} scheduled</span>
                        </div>
                        <UpcomingList items={upcoming} />
                    </section>
                </div>
            </div>
        </div>
    );
}

function AdminPortal({
    adminAuthenticated,
    adminAuthError,
    onAdminLogin,
    onAdminLogout,
    onClearAdminAuthError,
    adminForm,
    setAdminForm,
    adminLoading,
    adminError,
    adminUsers,
    adminEvents,
    onLoadAdminData,
    onSaveAdminUser,
    onRemoveAdminUser,
    onClearEvents,
    onSwitchPortal
}) {
    if (!adminAuthenticated) {
        return (
            <div className="login-screen">
                <div className="login-grid">
                    <div className="login-column">
                        <AdminLoginCard
                            isAuthenticated={adminAuthenticated}
                            errorMessage={adminAuthError}
                            onLogin={onAdminLogin}
                            onLogout={onAdminLogout}
                            onClearError={onClearAdminAuthError}
                        />
                        <div style={{ marginTop: "0.75rem", textAlign: "center" }}>
                            <button className="pill-btn" type="button" onClick={onSwitchPortal}>
                                User portal
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    const shellStyle = {
        minHeight: "100vh",
        background: "linear-gradient(135deg, #f8fafc 0%, #eef2ff 100%)",
        padding: "1.5rem",
        boxSizing: "border-box"
    };
    const cardStyle = {
        background: "#fff",
        borderRadius: "16px",
        boxShadow: "0 12px 30px rgba(15, 23, 42, 0.08)",
        padding: "1.25rem"
    };
    const headerStyle = {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: "1rem"
    };
    const badgeStyle = {
        background: "#eef2ff",
        color: "#4338ca",
        padding: "0.45rem 0.75rem",
        borderRadius: "999px",
        fontWeight: 600,
        fontSize: "0.9rem"
    };

    return (
        <div style={shellStyle}>
            <div style={headerStyle}>
                <div>
                    <h1 style={{ margin: 0, color: "#0f172a" }}>Admin dashboard</h1>
                    <p style={{ margin: "0.2rem 0", color: "#64748b" }}>Manage members and review activity</p>
                </div>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                    <span style={badgeStyle}>Signed in as {ADMIN_LOGIN.name}</span>
                    <button className="pill-btn" type="button" onClick={onAdminLogout}>
                        Log out
                    </button>
                </div>
            </div>

            <div
                style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(340px, 2fr) minmax(420px, 3fr)",
                    gap: "1rem",
                    alignItems: "start"
                }}
            >
                <div style={cardStyle}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <h2 style={{ margin: 0, color: "#0f172a" }}>Create / update user</h2>
                    </div>
                    <div style={{ display: "grid", gap: "0.75rem", marginTop: "1rem" }}>
                        <label style={{ display: "grid", gap: "0.35rem", fontWeight: 600, color: "#0f172a" }}>
                            Full name
                            <input
                                className="input-control"
                                type="text"
                                value={adminForm.name}
                                onChange={(e) => setAdminForm((prev) => ({ ...prev, name: e.target.value }))}
                                placeholder="Jane Doe"
                            />
                        </label>
                        <label style={{ display: "grid", gap: "0.35rem", fontWeight: 600, color: "#0f172a" }}>
                            Location (optional)
                            <input
                                className="input-control"
                                type="text"
                                value={adminForm.location}
                                onChange={(e) => setAdminForm((prev) => ({ ...prev, location: e.target.value }))}
                                placeholder="City, Country"
                            />
                        </label>
                        <label style={{ display: "grid", gap: "0.35rem", fontWeight: 600, color: "#0f172a" }}>
                            Access code
                            <input
                                className="input-control"
                                type="password"
                                value={adminForm.pin}
                                onChange={(e) => setAdminForm((prev) => ({ ...prev, pin: e.target.value }))}
                                placeholder="Set a PIN"
                            />
                        </label>
                    </div>
                    <button
                        className="primary-btn"
                        type="button"
                        style={{ width: "100%", marginTop: "1rem" }}
                        onClick={onSaveAdminUser}
                        disabled={adminLoading}
                    >
                        {adminLoading ? "Saving..." : "Save user"}
                    </button>
                    {adminError && <div className="empty-state" style={{ marginTop: "0.75rem" }}>{adminError}</div>}
                </div>

                <div style={{ ...cardStyle, minHeight: "320px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <h2 style={{ margin: 0, color: "#0f172a" }}>Users</h2>
                        <small style={{ color: "#64748b" }}>{adminUsers.length} total</small>
                    </div>
                    {!adminUsers.length ? (
                        <div className="empty-state" style={{ marginTop: "1rem" }}>
                            No users yet. Add a member to begin.
                        </div>
                    ) : (
                        <ul
                            className="admin-list"
                            style={{
                                marginTop: "0.75rem",
                                maxHeight: "760px",
                                overflowY: "auto",
                                paddingRight: "0.25rem",
                                display: "grid",
                                gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                                gap: "0.65rem"
                            }}
                        >
                            {adminUsers.map((user) => (
                                <li
                                    key={user.name}
                                    className="admin-row"
                                    style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
                                >
                                    <div>
                                        <div style={{ fontWeight: 600 }}>{user.name}</div>
                                        <small style={{ color: "#94a3b8" }}>{user.location || "No location provided"}</small>
                                    </div>
                                    <div style={{ textAlign: "right" }}>
                                        <div>{user.totalApplications || 0} apps</div>
                                        <small style={{ color: "#94a3b8" }}>
                                            Last login: {formatDateTime(user.lastLogin)}
                                        </small>
                                        <small style={{ color: "#94a3b8", display: "block" }}>
                                            Last seen: {formatDateTime(user.lastSeen)}
                                        </small>
                                        <small style={{ color: "#94a3b8", display: "block" }}>
                                            Access code: {user.pinSet ? "set" : "missing"}
                                        </small>
                                        <button
                                            className="mini-btn danger"
                                            type="button"
                                            style={{ marginTop: "0.35rem" }}
                                            onClick={() => onRemoveAdminUser(user.name)}
                                            disabled={adminLoading}
                                        >
                                            Remove
                                        </button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>

            <div style={{ marginTop: "1rem", ...cardStyle }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <h2 style={{ margin: 0, color: "#0f172a" }}>Recent activity</h2>
                    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                        <small style={{ color: "#64748b" }}>{adminEvents.length} events</small>
                        <button
                            className="pill-btn"
                            type="button"
                            onClick={onClearEvents}
                            disabled={adminLoading}
                        >
                            Clear all
                        </button>
                    </div>
                </div>
                {!adminEvents.length ? (
                    <div className="empty-state" style={{ marginTop: "0.75rem" }}>
                        No events yet.
                    </div>
                ) : (
                    <ul
                        className="admin-list"
                        style={{
                            marginTop: "0.75rem",
                            maxHeight: "680px",
                            overflowY: "auto",
                            paddingRight: "0.25rem",
                            display: "grid",
                            gap: "0.5rem"
                        }}
                    >
                        {adminEvents.map((event, idx) => (
                            <li
                                key={`${event.timestamp}-${idx}`}
                                className="admin-row"
                                style={{
                                    display: "grid",
                                    gridTemplateColumns: "1fr auto",
                                    alignItems: "center",
                                    padding: "0.65rem 0.85rem",
                                    borderRadius: "12px",
                                    background: "#f8fafc",
                                    border: "1px solid #e2e8f0"
                                }}
                            >
                                <div>
                                    <div style={{ fontWeight: 700, fontSize: "0.95rem", color: "#0f172a" }}>
                                        {event.type}
                                    </div>
                                    <small style={{ color: "#94a3b8", fontSize: "0.85rem" }}>
                                        {event.owner || "Unknown"}
                                    </small>
                                </div>
                                <small style={{ color: "#94a3b8", fontSize: "0.85rem", textAlign: "right" }}>
                                    {formatDateTime(event.timestamp)}
                                </small>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}

function AdminPanel({
    title = "Admin",
    adminForm,
    setAdminForm,
    adminLoading,
    adminError,
    adminUsers,
    adminEvents,
    onLoadAdminData,
    onSaveAdminUser
}) {
    return (
        <section className="card">
            <div className="section-heading">
                <h2>{title}</h2>
            </div>
            <div className="admin-panel">
                <div className="admin-form">
                    <label>
                        New user name
                        <input
                            className="input-control"
                            type="text"
                            value={adminForm.name}
                            onChange={(e) => setAdminForm((prev) => ({ ...prev, name: e.target.value }))}
                            placeholder="Jane Doe"
                        />
                    </label>
                    <label>
                        Location (optional)
                        <input
                            className="input-control"
                            type="text"
                            value={adminForm.location}
                            onChange={(e) => setAdminForm((prev) => ({ ...prev, location: e.target.value }))}
                            placeholder="City, Country"
                        />
                    </label>
                    <label>
                        Access code
                        <input
                            className="input-control"
                            type="password"
                            value={adminForm.pin}
                            onChange={(e) => setAdminForm((prev) => ({ ...prev, pin: e.target.value }))}
                            placeholder="Set a PIN"
                        />
                    </label>
                </div>
                <button
                    className="ghost-btn"
                    type="button"
                    onClick={onSaveAdminUser}
                    disabled={adminLoading}
                    style={{ width: "100%" }}
                >
                    {adminLoading ? "Saving..." : "Create / Update user"}
                </button>
                <button
                    className="primary-btn"
                    type="button"
                    onClick={onLoadAdminData}
                    disabled={adminLoading}
                    style={{ width: "100%" }}
                >
                    {adminLoading ? "Loading..." : "Load admin data"}
                </button>
                {adminError && <div className="empty-state">{adminError}</div>}
                {!!adminUsers.length && (
                    <div style={{ marginTop: "1rem" }}>
                        <strong>Users</strong>
                        <ul className="admin-list">
                            {adminUsers.map((user) => (
                                <li key={user.name} className="admin-row">
                                    <div>
                                        <div style={{ fontWeight: 600 }}>{user.name}</div>
                                        <small style={{ color: "#94a3b8" }}>{user.location || "No location provided"}</small>
                                    </div>
                                    <div style={{ textAlign: "right" }}>
                                        <div>{user.totalApplications || 0} apps</div>
                                        <small style={{ color: "#94a3b8" }}>
                                            Last login: {formatDateTime(user.lastLogin)}
                                        </small>
                                        <small style={{ color: "#94a3b8", display: "block" }}>
                                            Last seen: {formatDateTime(user.lastSeen)}
                                        </small>
                                        <small style={{ color: "#94a3b8", display: "block" }}>
                                            Access code: {user.pinSet ? "set" : "missing"}
                                        </small>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
                {!!adminEvents.length && (
                    <div style={{ marginTop: "1rem" }}>
                        <strong>Recent activity</strong>
                        <ul className="admin-list">
                            {adminEvents.map((event, idx) => (
                                <li key={`${event.timestamp}-${idx}`} className="admin-row">
                                    <div>
                                        <div style={{ fontWeight: 600 }}>{event.type}</div>
                                        <small style={{ color: "#94a3b8" }}>{event.owner || "Unknown"}</small>
                                    </div>
                                    <small style={{ color: "#94a3b8" }}>{formatDateTime(event.timestamp)}</small>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </div>
        </section>
    );
}

function AdminLoginCard({ isAuthenticated, errorMessage, onLogin, onLogout, onClearError }) {
    const [name, setName] = useState("");
    const [password, setPassword] = useState("");

    const handleSubmit = async (event) => {
        event.preventDefault();
        const didLogin = await onLogin({ name, password });
        if (didLogin) {
            setPassword("");
        }
    };

    const handleChange = (setter) => (event) => {
        setter(event.target.value);
        if (errorMessage) {
            onClearError?.();
        }
    };

    const handleLogout = () => {
        setName("");
        setPassword("");
        onLogout();
    };

    return (
        <div className="card auth-card">
            <h1>Admin login</h1>
            <p>Admin access is limited to the trackeradmin account.</p>
            {!isAuthenticated ? (
                <form onSubmit={handleSubmit} className="auth-form">
                    <label>
                        Admin name
                        <input
                            className="input-control"
                            type="text"
                            placeholder={""}
                            value={name}
                            onChange={handleChange(setName)}
                            required
                        />
                    </label>
                    <label>
                        Password
                        <input
                            className="input-control"
                            type="password"
                            placeholder=""
                            value={password}
                            onChange={handleChange(setPassword)}
                            required
                        />
                    </label>
                    <button className="primary-btn" type="submit" style={{ width: "100%" }}>
                        Sign in
                    </button>
                </form>
            ) : (
                <div className="auth-status">
                    <div>
                        <strong>Signed in as {ADMIN_LOGIN.name}</strong>
                        <small>Admin tools are unlocked below.</small>
                    </div>
                    <button className="pill-btn" type="button" onClick={handleLogout}>
                        Sign out
                    </button>
                </div>
            )}
            {errorMessage && <div className="empty-state">{errorMessage}</div>}
        </div>
    );
}

function LoginScreen({ onSubmit, isSaving, errorMessage, onSwitchPortal }) {
    const [name, setName] = useState("");
    const [location, setLocation] = useState("");
    const [pin, setPin] = useState("");

    const handleSubmit = (event) => {
        event.preventDefault();
        const nextProfile = { name: name.trim(), location: location.trim(), pin: pin.trim() };
        if (!nextProfile.name) return;
        onSubmit(nextProfile);
    };

    return (
        <div className="login-screen">
            <div className="login-grid">
                <div className="login-column">
                    <div className="card auth-card">
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <h1>Member login</h1>
                            <button className="pill-btn" type="button" onClick={onSwitchPortal}>
                                Admin portal
                            </button>
                        </div>
                        <p>Sign in with your name to load your applications.</p>
                        <form onSubmit={handleSubmit} className="auth-form">
                            <label>
                                Full name
                                <input
                                    className="input-control"
                                    type="text"
                                    placeholder="Jane Doe"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    required
                                />
                            </label>
                            <label>
                                Access code
                                <input
                                    className="input-control"
                                    type="password"
                                    placeholder="Provided by admin"
                                    value={pin}
                                    onChange={(e) => setPin(e.target.value)}
                                    required
                                />
                            </label>
                            <label>
                                Location (optional)
                                <input
                                    className="input-control"
                                    type="text"
                                    placeholder="Remote / City, Country"
                                    value={location}
                                    onChange={(e) => setLocation(e.target.value)}
                                />
                            </label>
                            <button className="primary-btn" type="submit" style={{ width: "100%" }} disabled={isSaving}>
                                {isSaving ? "Signing in..." : "Continue"}
                            </button>
                            {errorMessage && <div className="empty-state">{errorMessage}</div>}
                        </form>
                    </div>
                </div>
            </div>
        </div>
    );
}

function StatsRow({ statusCounts, total }) {
    const cards = [
        { id: "wishlist", title: "Discovery list", subtitle: "Roles to explore", initials: "WL", accent: STATUS_ACCENTS.wishlist },
        { id: "applied", title: "Active submissions", subtitle: "Forms sent out", initials: "AP", accent: STATUS_ACCENTS.applied },
        { id: "interview", title: "Interview loop", subtitle: "Conversations live", initials: "IN", accent: STATUS_ACCENTS.interview }
    ];

    return (
        <div className="stat-grid">
            {cards.map((card) => {
                const count = statusCounts[card.id] || 0;
                const ratio = total ? Math.min(1, count / total) : 0;
                return (
                    <article className="stat-card" key={card.id}>
                        <div className="stat-avatar" style={{ background: card.accent }}>
                            {card.initials}
                        </div>
                        <h3>{card.title}</h3>
                        <small>{card.subtitle}</small>
                        <strong>{count}</strong>
                        <div className="stat-progress">
                            <span style={{ width: `${ratio * 100}%`, background: card.accent }}></span>
                        </div>
                        <span className="stat-meta">{Math.round(ratio * 100)}% of pipeline</span>
                    </article>
                );
            })}
        </div>
    );
}

function TimelineChart({ data }) {
    const width = 360;
    const height = 140;
    const maxValue = Math.max(
        1,
        ...data.flatMap((entry) => timelineStatuses.map((status) => entry[status] || 0))
    );
    const horizontalStep = Math.max(1, data.length - 1);
    const pointsFor = (status) =>
        data
            .map((entry, index) => {
                const value = entry[status] || 0;
                const x = 10 + (index / horizontalStep) * (width - 20);
                const y = height - 15 - (value / maxValue) * (height - 35);
                return `${x},${y}`;
            })
            .join(" ");

    return (
        <div className="chart">
            <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Applications timeline">
                <g stroke="#e2e8f0" strokeWidth="1">
                    {[1, 2, 3].map((line) => (
                        <line
                            key={line}
                            x1="0"
                            x2={width}
                            y1={(line / 4) * height}
                            y2={(line / 4) * height}
                        />
                    ))}
                </g>
                {timelineStatuses.map((status) => (
                    <polyline
                        key={status}
                        fill="none"
                        stroke={STATUS_ACCENTS[status]}
                        strokeWidth="3"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        opacity={status === "applied" ? 1 : 0.75}
                        points={pointsFor(status)}
                    />
                ))}
            </svg>
            <div className="chart-legend">
                {timelineStatuses.map((status) => (
                    <div className="legend-pill" key={status}>
                        <span style={{ background: STATUS_ACCENTS[status] }}></span>
                        {statusLabel(status)}
                    </div>
                ))}
            </div>
        </div>
    );
}

function KanbanBoard({ columns, filters, onChangeStatus, onAdvance, onReject, onDelete }) {
    return (
        <div className="kanban-grid">
            {columns.map(({ status, entries }) => (
                <article
                    key={status.id}
                    className={`column ${filters.status !== "all" && filters.status !== status.id ? "is-muted" : ""}`}
                >
                    <header>
                        <h3>{status.label}</h3>
                        <span>{entries.length}</span>
                    </header>
                    {entries.length ? (
                        entries.map((application) => (
                            <ApplicationCard
                                key={application.id}
                                application={application}
                                onChangeStatus={onChangeStatus}
                                onAdvance={onAdvance}
                                onReject={onReject}
                                onDelete={onDelete}
                            />
                        ))
                    ) : (
                        <div className="empty-state">No {status.label.toLowerCase()} items match your filters.</div>
                    )}
                </article>
            ))}
        </div>
    );
}

function ApplicationCard({ application, onChangeStatus, onAdvance, onReject, onDelete }) {
    const currentIndex = STATUS_CONFIG.findIndex((status) => status.id === application.status);
    const nextStatus = STATUS_CONFIG[currentIndex + 1];
    return (
        <div className="application-card">
            <h4>
                {application.company}
                <span>{application.role}</span>
            </h4>
            <p>
                Stage:
                <span className={`status-pill pill-${application.status}`}>{statusLabel(application.status)}</span>
            </p>
            <p>
                Applied: <strong>{formatDate(application.date)}</strong>
            </p>
            <div className="card-tags">
                {application.location && <span>{application.location}</span>}
                {application.link && (
                    <span>
                        <a href={application.link} target="_blank" rel="noopener noreferrer">
                            Job posting link
                        </a>
                    </span>
                )}
            </div>
            {application.notes && <p>{application.notes}</p>}
            <div className="card-actions">
                <select
                    className="select-control"
                    value={application.status}
                    onChange={(event) => onChangeStatus(application.id, event.target.value)}
                >
                    {STATUS_CONFIG.map((status) => (
                        <option key={status.id} value={status.id}>
                            {status.label}
                        </option>
                    ))}
                </select>
                {nextStatus && (
                    <button className="mini-btn" type="button" onClick={() => onAdvance(application.id, nextStatus.id)}>
                        Move to {nextStatus.label}
                    </button>
                )}
                <button className="mini-btn danger" type="button" onClick={() => onReject(application.id)}>
                    Mark rejected
                </button>
                <button className="mini-btn" type="button" onClick={() => onDelete(application.id)}>
                    Remove
                </button>
            </div>
        </div>
    );
}

function FiltersPanel({ filters, onChange }) {
    return (
        <div className="filter-grid">
            <label>
                Status
                <select
                    className="select-control"
                    value={filters.status}
                    onChange={(event) => onChange("status", event.target.value)}
                >
                    <option value="all">All</option>
                    {STATUS_CONFIG.map((status) => (
                        <option key={status.id} value={status.id}>
                            {status.label}
                        </option>
                    ))}
                </select>
            </label>
            <label>
                Keyword
                <input
                    className="input-control"
                    type="text"
                    placeholder="Company, role, notes..."
                    value={filters.text}
                    onChange={(event) => onChange("text", event.target.value)}
                />
            </label>
        </div>
    );
}

function UpcomingList({ items }) {
    if (!items.length) {
        return <div className="empty-state">Add interview dates to see upcoming checkpoints.</div>;
    }
    return (
        <ul className="upcoming-list">
            {items.map((item, index) => (
                <li className="upcoming-item" key={item.id}>
                    <span
                        className="badge"
                        style={{ background: badgePalette[index % badgePalette.length] }}
                        aria-hidden="true"
                    >
                        {getInitials(item.company)}
                    </span>
                    <div>
                        <strong>{item.company}</strong>
                        <p style={{ margin: "0.1rem 0", color: "#94a3b8" }}>{item.role}</p>
                        <small>{formatDate(item.date)}</small>
                    </div>
                    <span className={`status-pill pill-${item.status}`}>{statusLabel(item.status)}</span>
                </li>
            ))}
        </ul>
    );
}

function ProgressDonut({ ratio }) {
    const size = 180;
    const stroke = 16;
    const radius = (size - stroke) / 2;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - ratio * circumference;
    const percent = Math.round(ratio * 100);

    return (
        <div className="progress-ring">
            <svg width={size} height={size}>
                <circle
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    fill="transparent"
                    stroke="#e2e8f0"
                    strokeWidth={stroke}
                />
                <circle
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    fill="transparent"
                    stroke="#7c3aed"
                    strokeWidth={stroke}
                    strokeDasharray={circumference}
                    strokeDashoffset={offset}
                    strokeLinecap="round"
                />
            </svg>
            <div className="progress-ring__label">
                <span>{percent}%</span>
                <small style={{ display: "block", color: "#94a3b8", fontSize: "0.8rem" }}>Productive</small>
            </div>
        </div>
    );
}

function buildTimelineData(applications) {
    const template = timelineDays.map((day) => ({
        day,
        wishlist: 0,
        applied: 0,
        interview: 0
    }));
    let hasSignal = false;

    applications.forEach((app) => {
        if (!timelineStatuses.includes(app.status)) return;
        const date = parseISODate(app.date);
        if (!date) return;
        const dayIndex = (date.getDay() + 6) % 7;
        template[dayIndex][app.status] += 1;
        hasSignal = true;
    });

    return hasSignal ? template : fallbackTimeline;
}

function buildUpcomingDeadlines(applications) {
    return [...applications]
        .filter((app) => app.status !== "rejected")
        .sort((a, b) => {
            const aDate = parseISODate(a.date);
            const bDate = parseISODate(b.date);
            if (aDate && bDate) return aDate - bDate;
            if (aDate) return -1;
            if (bDate) return 1;
            return (b.createdAt || 0) - (a.createdAt || 0);
        })
        .slice(0, 5);
}

function parseISODate(value) {
    if (!value) return null;
    const parsed = new Date(`${value}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDate(value) {
    const parsed = parseISODate(value);
    if (!parsed) return "Date TBD";
    return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function statusLabel(statusId) {
    return STATUS_CONFIG.find((status) => status.id === statusId)?.label ?? statusId;
}

function getInitials(value) {
    return value
        .split(" ")
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0])
        .join("")
        .toUpperCase();
}

function formatDateTime(value) {
    if (!value) return "Unknown";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Unknown";
    return date.toLocaleString();
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
