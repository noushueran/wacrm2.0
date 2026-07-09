"use client";

import { useEffect, useState } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import {
  Authenticated,
  AuthLoading,
  Unauthenticated,
  useMutation,
  usePaginatedQuery,
  useQuery,
} from "convex/react";
import { ConvexError } from "convex/values";
import { Loader2, LogOut, Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// ============================================================
// Phase 0, Task 8 — a self-contained browser proof of the Convex stack:
// Convex Auth (Password) sign-up/sign-in, `accounts.bootstrapAccount`,
// and reactive contacts CRUD + search + tag filter through the
// accountQuery/accountMutation security spine (`convex/contacts.ts`,
// `convex/tags.ts`). This is a proof, not production UI — deliberately
// outside `(dashboard)`/`(auth)` and outside `src/middleware.ts`'s
// `protectedPaths`, so it never touches Supabase auth or /contacts.
//
// Every list here is a live Convex subscription: creating/deleting a
// contact updates the list below without any manual refetch.
//
// Note: there's no tag-*creation* UI here on purpose (out of scope per
// the brief) — the tag filter only has something to filter once a tag
// exists (e.g. inserted via the Convex dashboard or `api.tags.create`).
// ============================================================

export default function ConvexDemoPage() {
  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-4 py-10">
      <header>
        <h1 className="text-2xl font-bold text-foreground">Convex demo</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Phase 0 proof: Convex Auth + reactive contacts/tags. Not linked
          from anywhere else in the app.
        </p>
      </header>

      <AuthLoading>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Checking session…
        </div>
      </AuthLoading>

      <Unauthenticated>
        <AuthForm />
      </Unauthenticated>

      <Authenticated>
        <AuthenticatedDemo />
      </Authenticated>
    </div>
  );
}

// ============================================================
// Error helpers — a ConvexError's `.data` survives the client boundary
// intact (unlike a plain Error, which is sanitized to an opaque "Server
// Error"); see convex/auth.ts's password-length check for the case this
// matters most.
// ============================================================

function errorMessage(err: unknown): string {
  if (err instanceof ConvexError) {
    return typeof err.data === "string" ? err.data : JSON.stringify(err.data);
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

function isDuplicatePhoneError(err: unknown): boolean {
  return (
    err instanceof ConvexError &&
    typeof err.data === "object" &&
    err.data !== null &&
    (err.data as { code?: unknown }).code === "DUPLICATE_PHONE"
  );
}

// ============================================================
// Sign in / sign up — Convex Auth Password provider only.
// ============================================================

function AuthForm() {
  const { signIn } = useAuthActions();
  const [flow, setFlow] = useState<"signIn" | "signUp">("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await signIn("password", { email, password, flow });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">
          {flow === "signIn" ? "Sign in" : "Sign up"}
        </CardTitle>
        <CardDescription>
          Convex Auth (Password provider) — a separate identity system from
          the app&apos;s Supabase login.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {error && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              {error}
            </div>
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor="convex-demo-email">Email</Label>
            <Input
              id="convex-demo-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="convex-demo-password">Password</Label>
            <Input
              id="convex-demo-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete={
                flow === "signIn" ? "current-password" : "new-password"
              }
            />
            {flow === "signUp" && (
              <p className="text-xs text-muted-foreground">
                At least 8 characters.
              </p>
            )}
          </div>

          <Button type="submit" disabled={loading}>
            {loading && <Loader2 className="size-4 animate-spin" />}
            {flow === "signIn" ? "Sign in" : "Create account"}
          </Button>
        </form>

        <button
          type="button"
          onClick={() => {
            setFlow((f) => (f === "signIn" ? "signUp" : "signIn"));
            setError(null);
          }}
          className="mt-4 text-sm text-primary hover:text-primary/80"
        >
          {flow === "signIn"
            ? "Need an account? Sign up"
            : "Already have an account? Sign in"}
        </button>
      </CardContent>
    </Card>
  );
}

// ============================================================
// Authenticated shell — bootstrap the account once, then show contacts.
// ============================================================

function AuthenticatedDemo() {
  const { signOut } = useAuthActions();
  const bootstrapAccount = useMutation(api.accounts.bootstrapAccount);
  const [status, setStatus] = useState<"pending" | "ready" | "error">(
    "pending",
  );
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    bootstrapAccount({})
      .then(() => {
        if (!cancelled) setStatus("ready");
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setBootstrapError(errorMessage(err));
          setStatus("error");
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time idempotent bootstrap call on mount (bootstrapAccount is a documented no-op after the first call), not a render-driven cascade
  }, [bootstrapAccount]);

  function retryBootstrap() {
    setStatus("pending");
    setBootstrapError(null);
    bootstrapAccount({})
      .then(() => setStatus("ready"))
      .catch((err: unknown) => {
        setBootstrapError(errorMessage(err));
        setStatus("error");
      });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3">
        <span className="text-sm text-muted-foreground">
          Signed in
          {status === "ready" && " · account ready"}
          {status === "pending" && " · bootstrapping account…"}
          {status === "error" && " · bootstrap failed"}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void signOut();
          }}
        >
          <LogOut className="size-4" />
          Sign out
        </Button>
      </div>

      {status === "pending" && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Setting up your account…
        </div>
      )}

      {status === "error" && (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          <span>Failed to bootstrap account: {bootstrapError}</span>
          <Button variant="outline" size="sm" onClick={retryBootstrap}>
            Retry
          </Button>
        </div>
      )}

      {status === "ready" && <ContactsPanel />}
    </div>
  );
}

// ============================================================
// Contacts panel — create, search, tag filter, paginated list, delete.
// ============================================================

function ContactsPanel() {
  const [search, setSearch] = useState("");
  const [selectedTagIds, setSelectedTagIds] = useState<Id<"tags">[]>([]);

  const tags = useQuery(api.tags.list);

  const paginated = usePaginatedQuery(
    api.contacts.list,
    { search },
    { initialNumItems: 25 },
  );

  const filtered = useQuery(
    api.contacts.filterByTags,
    selectedTagIds.length > 0
      ? { tagIds: selectedTagIds, search, limit: 25, offset: 0 }
      : "skip",
  );

  const removeContact = useMutation(api.contacts.remove);

  function toggleTag(tagId: Id<"tags">) {
    setSelectedTagIds((prev) =>
      prev.includes(tagId)
        ? prev.filter((id) => id !== tagId)
        : [...prev, tagId],
    );
  }

  async function handleDelete(contactId: Id<"contacts">, label: string) {
    try {
      await removeContact({ contactId });
      toast.success(`Deleted ${label}`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const usingTagFilter = selectedTagIds.length > 0;
  const items = usingTagFilter ? (filtered?.items ?? []) : paginated.results;
  const isLoading = usingTagFilter
    ? filtered === undefined
    : paginated.status === "LoadingFirstPage";

  return (
    <div className="flex flex-col gap-6">
      <CreateContactForm />

      <div className="flex flex-col gap-3">
        <div className="relative max-w-sm">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search contacts…"
            className="pl-8"
          />
        </div>

        {tags && tags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {tags.map((tag) => {
              const active = selectedTagIds.includes(tag._id);
              return (
                <button
                  key={tag._id}
                  type="button"
                  onClick={() => toggleTag(tag._id)}
                  className="rounded-full border px-2 py-0.5 text-[11px] font-medium"
                  style={{
                    borderColor: tag.color,
                    color: tag.color,
                    backgroundColor: active ? `${tag.color}30` : "transparent",
                  }}
                >
                  {tag.name}
                </button>
              );
            })}
            {usingTagFilter && (
              <button
                type="button"
                onClick={() => setSelectedTagIds([])}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Clear filter
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading contacts…
          </div>
        ) : items.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            No contacts yet.
          </p>
        ) : (
          items.map((contact) => (
            <div
              key={contact._id}
              className="flex items-center justify-between gap-4 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">
                  {contact.name || (
                    <span className="italic text-muted-foreground">
                      Unnamed
                    </span>
                  )}
                </p>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {contact.phone}
                  {contact.company ? ` · ${contact.company}` : ""}
                  {contact.email ? ` · ${contact.email}` : ""}
                </p>
                {contact.tags.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {contact.tags.map((tag) => (
                      <Badge
                        key={tag._id}
                        variant="outline"
                        style={{ borderColor: tag.color, color: tag.color }}
                      >
                        {tag.name}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() =>
                  handleDelete(contact._id, contact.name || contact.phone)
                }
                aria-label={`Delete ${contact.name || contact.phone}`}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))
        )}
      </div>

      {!usingTagFilter && paginated.status === "CanLoadMore" && (
        <Button
          variant="outline"
          onClick={() => paginated.loadMore(25)}
          className="self-center"
        >
          Load more
        </Button>
      )}
      {usingTagFilter && filtered && filtered.total > items.length && (
        <p className="text-center text-xs text-muted-foreground">
          Showing {items.length} of {filtered.total} — narrow your search to
          see more.
        </p>
      )}
    </div>
  );
}

function CreateContactForm() {
  const createContact = useMutation(api.contacts.create);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPhoneError(null);
    setSubmitting(true);
    try {
      await createContact({
        phone,
        name: name || undefined,
        email: email || undefined,
        company: company || undefined,
      });
      toast.success("Contact created");
      setName("");
      setPhone("");
      setEmail("");
      setCompany("");
    } catch (err) {
      if (isDuplicatePhoneError(err)) {
        setPhoneError("A contact with this phone number already exists.");
      } else {
        toast.error(errorMessage(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base text-foreground">
          Add contact
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={handleSubmit}
          className="flex flex-wrap items-start gap-3"
        >
          <div className="flex min-w-40 flex-1 flex-col gap-1">
            <Label htmlFor="convex-demo-phone">Phone *</Label>
            <Input
              id="convex-demo-phone"
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value);
                setPhoneError(null);
              }}
              required
              placeholder="+1 555 000 1111"
            />
            {phoneError && (
              <p className="text-xs text-red-400">{phoneError}</p>
            )}
          </div>
          <div className="flex min-w-40 flex-1 flex-col gap-1">
            <Label htmlFor="convex-demo-name">Name</Label>
            <Input
              id="convex-demo-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex min-w-40 flex-1 flex-col gap-1">
            <Label htmlFor="convex-demo-contact-email">Email</Label>
            <Input
              id="convex-demo-contact-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="flex min-w-40 flex-1 flex-col gap-1">
            <Label htmlFor="convex-demo-company">Company</Label>
            <Input
              id="convex-demo-company"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={submitting} className="mt-6">
            {submitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            Add
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
