import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  usePaseo,
  useRpc,
  type PluginScreenParams,
  type PluginScreenProps,
} from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Loading, TextInput } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  ActivityIndicator,
  Pressable,
  Text,
  View,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
  type TextStyle,
} from "react-native";
import {
  createSandboxedWorkspaceRpc,
  describeProfile,
  listContainerProfilesRpc,
  listRefsRpc,
  type ContainerProfile,
} from "../shared/rpc";
import { ProfileEditor, type ProfileEditorTarget } from "./profile-editor";
import {
  Dropdown,
  FieldTrigger,
  FONT,
  ICON,
  WEB_NO_OUTLINE,
  placeholderColor,
  type DropdownOption,
  type Glyph,
} from "./standard-ui";

type PickerKind = "project" | "isolation" | "profile" | "ref";
type Isolation = "worktree" | "directory";

const GLYPH_CONTAINER: Glyph = { kind: "icon", name: "Container" };
const GLYPH_BRANCH: Glyph = { kind: "icon", name: "GitBranch" };
const GLYPH_FOLDER: Glyph = { kind: "icon", name: "Folder" };
const GLYPH_PLUS: Glyph = { kind: "icon", name: "Plus" };
const GLYPH_PENCIL: Glyph = { kind: "icon", name: "Pencil" };
const ISOLATION_LABELS: Record<Isolation, string> = {
  directory: "Sandboxed directory",
  worktree: "Sandboxed worktree",
};
const ISOLATION_OPTIONS: Isolation[] = ["directory", "worktree"];
const NEW_PROFILE = "new-profile";
const EDIT_PROFILE = "edit-profile";

function projectName(project: { projectCustomName?: string | null; projectDisplayName: string }) {
  return project.projectCustomName ?? project.projectDisplayName;
}

function buildCreateInput(input: {
  projectId: string;
  profileId: string | null;
  isolation: Isolation;
  baseRef: string | null;
  title: string;
}) {
  const title = input.title.trim();
  return {
    projectId: input.projectId,
    ...(input.profileId ? { profileId: input.profileId } : {}),
    isolation: input.isolation,
    ...(input.isolation === "worktree" && input.baseRef ? { baseRef: input.baseRef } : {}),
    ...(title ? { title } : {}),
  };
}

function useSandboxLists() {
  const paseo = usePaseo();
  const listProfiles = useRpc(listContainerProfilesRpc);
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: async () => (await paseo.projects.list()).projects,
  });
  const profiles = useQuery({ queryKey: ["container-profiles"], queryFn: () => listProfiles({}) });
  return {
    loading: projects.isPending || profiles.isPending,
    error: projects.error ?? profiles.error,
    projects: projects.data ?? [],
    profiles: profiles.data ?? { profiles: [], defaultId: "" },
  };
}

/** Everything the form reads and submits; the components below only lay it out. */
function useSandboxForm(params: PluginScreenParams, openWorkspace: (workspaceId: string) => void) {
  const listRefs = useRpc(listRefsRpc);
  const createWorkspace = useRpc(createSandboxedWorkspaceRpc);
  const lists = useSandboxLists();
  const [projectId, setProjectId] = useState(params.projectId ?? "");
  const [profileId, setProfileId] = useState<string | null>(null);
  const [baseRef, setBaseRef] = useState<string | null>(null);
  // As New workspace's Isolation: a worktree, or the project directory itself ("Local").
  const [isolationChoice, setIsolation] = useState<Isolation>("worktree");
  const [title, setTitle] = useState("");

  const project =
    lists.projects.find((candidate) => candidate.projectId === projectId) ?? lists.projects[0];
  const isGit = project?.projectKind === "git";
  const isolation: Isolation = isGit ? isolationChoice : "directory";
  const refs = useQuery({
    queryKey: ["refs", project?.projectId],
    queryFn: async () => listRefs({ projectId: project?.projectId ?? "" }),
    enabled: isGit,
  });
  // A different project starts from its own current branch.
  useEffect(() => setBaseRef(null), [project?.projectId]);
  const profile =
    lists.profiles.profiles.find((candidate) => candidate.id === profileId) ??
    lists.profiles.profiles.find((candidate) => candidate.id === lists.profiles.defaultId);

  // The workspace opens at once; its agents and terminals wait for the container as they launch.
  const create = useMutation({
    mutationFn: createWorkspace,
    onSuccess: ({ workspaceId }) => openWorkspace(workspaceId),
  });
  const submit = useCallback(() => {
    if (!project || create.isPending) return;
    create.mutate(
      buildCreateInput({
        projectId: project.projectId,
        profileId: profile?.id ?? null,
        isolation,
        baseRef,
        title,
      }),
    );
  }, [baseRef, create, isolation, profile, project, title]);

  return {
    lists,
    error: create.error ?? lists.error ?? refs.error,
    pending: create.isPending,
    refs: refs.data ?? { current: null, refs: [] },
    project,
    isGit,
    isolation,
    setIsolation,
    profile,
    startRef: baseRef ?? refs.data?.current ?? null,
    title,
    setProjectId,
    setProfileId,
    setBaseRef,
    setTitle,
    submit,
  };
}

type SandboxForm = ReturnType<typeof useSandboxForm>;

interface Anchors {
  project: RefObject<View | null>;
  isolation: RefObject<View | null>;
  profile: RefObject<View | null>;
  ref: RefObject<View | null>;
}

interface PartProps {
  theme: PluginTheme;
  compact: boolean;
  form: SandboxForm;
  anchors: Anchors;
  openPicker(kind: PickerKind): void;
}

/** Project, isolation, container profile, and branch, as New workspace's meta row. */
function SetupFields({ theme, compact, form, anchors, openPicker }: PartProps) {
  const openProject = useCallback(() => openPicker("project"), [openPicker]);
  const openIsolation = useCallback(() => openPicker("isolation"), [openPicker]);
  const openProfile = useCallback(() => openPicker("profile"), [openPicker]);
  const openRef = useCallback(() => openPicker("ref"), [openPicker]);
  const projectGlyph = useMemo<Glyph>(
    () => (form.project ? { kind: "initial", text: projectName(form.project) } : GLYPH_FOLDER),
    [form.project],
  );
  const variant = compact ? "field" : "badge";
  return (
    <>
      <FieldTrigger
        theme={theme}
        variant={variant}
        label="Project"
        value={form.project ? projectName(form.project) : "No projects"}
        glyph={projectGlyph}
        anchorRef={anchors.project}
        onPress={openProject}
        disabled={form.pending || form.lists.projects.length === 0}
        testID="sandbox-project-trigger"
      />
      {/* Only Git projects can have a worktree; other projects always use their directory. */}
      <FieldTrigger
        theme={theme}
        variant={variant}
        label="Isolation"
        value={ISOLATION_LABELS[form.isolation]}
        glyph={form.isolation === "worktree" ? GLYPH_BRANCH : GLYPH_FOLDER}
        anchorRef={anchors.isolation}
        {...(form.isGit ? { onPress: openIsolation } : {})}
        disabled={form.pending}
        testID="sandbox-isolation-trigger"
      />
      <FieldTrigger
        theme={theme}
        variant={variant}
        label="Container"
        value={form.profile?.name ?? "No profile"}
        glyph={GLYPH_CONTAINER}
        anchorRef={anchors.profile}
        onPress={openProfile}
        disabled={form.pending}
        testID="sandbox-profile-trigger"
      />
      {form.isolation === "worktree" ? (
        <FieldTrigger
          theme={theme}
          variant={variant}
          label="Branch"
          value={form.startRef ?? "Current branch"}
          glyph={GLYPH_BRANCH}
          anchorRef={anchors.ref}
          onPress={openRef}
          disabled={form.pending || form.refs.refs.length === 0}
          testID="sandbox-ref-trigger"
        />
      ) : null}
    </>
  );
}

function SendButton({ theme, form }: { theme: PluginTheme; form: SandboxForm }) {
  const label = "Create";
  const enabled = Boolean(form.project) && !form.pending;
  const style = useMemo(
    () => ({
      height: 28,
      minWidth: 28,
      ...(label ? { paddingHorizontal: 12 } : { width: 28 }),
      borderRadius: 14,
      backgroundColor: theme.colors.accent,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      marginLeft: 4,
      opacity: enabled ? 1 : 0.5,
    }),
    [enabled, label, theme],
  );
  const labelStyle = useMemo(
    () => ({
      fontSize: FONT.base,
      fontWeight: "500" as const,
      color: theme.colors.accentForeground,
    }),
    [theme],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Create workspace"
      onPress={form.submit}
      disabled={!enabled}
      style={style}
      testID="sandbox-submit"
    >
      {form.pending ? (
        <ActivityIndicator size="small" color={theme.colors.accentForeground} />
      ) : null}
      {!form.pending && label ? <Text style={labelStyle}>{label}</Text> : null}
      {!form.pending && !label ? (
        <Icon name="CornerDownLeft" size={ICON.md} color={theme.colors.accentForeground} />
      ) : null}
    </Pressable>
  );
}

function PromptComposer({ theme, compact, form }: Omit<PartProps, "anchors" | "openPicker">) {
  // Enter creates the workspace on the web, as the app's composer sends.
  const onKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData & { shiftKey?: boolean }>) => {
      if (event.nativeEvent.key !== "Enter" || event.nativeEvent.shiftKey || compact) return;
      event.preventDefault();
      form.submit();
    },
    [compact, form],
  );
  const styles = useMemo(
    () => ({
      frame: {
        flexShrink: 1,
        flexDirection: "column" as const,
        gap: 12,
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 16,
        paddingTop: compact ? 8 : 16,
        paddingBottom: compact ? 8 : 12,
        paddingHorizontal: compact ? 12 : 16,
        ...(compact
          ? {
              shadowColor: "rgba(0, 0, 0, 0.08)",
              shadowOffset: { width: 0, height: 2 },
              shadowRadius: 8,
            }
          : {}),
      },
      input: {
        width: "100%" as const,
        minHeight: compact ? 30 : 46,
        maxHeight: 160,
        color: theme.colors.foreground,
        fontSize: FONT.content,
        lineHeight: FONT.content * 1.4,
        textAlignVertical: "top" as const,
        ...WEB_NO_OUTLINE,
      } satisfies TextStyle,
      row: {
        flexDirection: "row" as const,
        alignItems: "flex-end" as const,
        justifyContent: "space-between" as const,
        marginHorizontal: -6,
      },
      left: { minWidth: 0, flexShrink: 1, flexGrow: 1, flexDirection: "row" as const },
      right: { flexDirection: "row" as const, alignItems: "center" as const, gap: 4 },
    }),
    [compact, theme],
  );
  return (
    <View style={styles.frame}>
      <TextInput
        value={form.title}
        onChangeText={form.setTitle}
        onKeyPress={onKeyPress}
        placeholder="Name the workspace (optional)"
        placeholderTextColor={placeholderColor(theme)}
        editable={!form.pending}
        style={styles.input}
        accessibilityLabel="Workspace name"
      />
      <View style={styles.row}>
        <View style={styles.left} />
        <View style={styles.right}>
          <SendButton theme={theme} form={form} />
        </View>
      </View>
    </View>
  );
}

function usePickerOptions(form: SandboxForm) {
  return useMemo(() => {
    const projects: DropdownOption[] = form.lists.projects.map((candidate) => ({
      id: candidate.projectId,
      label: projectName(candidate),
      description: candidate.projectRootPath,
      glyph: { kind: "initial", text: projectName(candidate) },
      selected: candidate.projectId === form.project?.projectId,
    }));
    const profiles: DropdownOption[] = form.lists.profiles.profiles.map((candidate) => ({
      id: candidate.id,
      label: candidate.name,
      description: describeProfile(candidate),
      glyph: GLYPH_CONTAINER,
      selected: candidate.id === form.profile?.id,
    }));
    const profileActions: DropdownOption[] = [
      { id: NEW_PROFILE, label: "New profile", glyph: GLYPH_PLUS },
    ];
    if (form.profile) {
      profileActions.push({
        id: EDIT_PROFILE,
        label: `Edit “${form.profile.name}”`,
        glyph: GLYPH_PENCIL,
      });
    }
    const refs: DropdownOption[] = form.refs.refs.map((ref) => ({
      id: ref.name,
      label: ref.name,
      glyph: GLYPH_BRANCH,
      selected: ref.name === form.startRef,
    }));
    const isolations: DropdownOption[] = ISOLATION_OPTIONS.map((isolation) => ({
      id: isolation,
      label: ISOLATION_LABELS[isolation],
      glyph: isolation === "worktree" ? GLYPH_BRANCH : GLYPH_FOLDER,
      selected: isolation === form.isolation,
    }));
    return { projects, isolations, profiles, profileActions, refs };
  }, [form]);
}

function FormPickers({
  theme,
  compact,
  form,
  anchors,
  rootRef,
  open,
  close,
  editProfiles,
}: {
  theme: PluginTheme;
  compact: boolean;
  form: SandboxForm;
  anchors: Anchors;
  rootRef: RefObject<View | null>;
  open: PickerKind | null;
  close: () => void;
  editProfiles: (id: string) => void;
}) {
  const options = usePickerOptions(form);
  const { setIsolation } = form;
  const selectIsolation = useCallback(
    (id: string) => setIsolation(id === "worktree" ? "worktree" : "directory"),
    [setIsolation],
  );
  return (
    <>
      <Dropdown
        theme={theme}
        compact={compact}
        open={open === "project"}
        onClose={close}
        anchorRef={anchors.project}
        rootRef={rootRef}
        title="Project"
        searchPlaceholder="Search projects"
        options={options.projects}
        onSelect={form.setProjectId}
        emptyText="No projects available."
        minWidth={400}
      />
      <Dropdown
        theme={theme}
        compact={compact}
        open={open === "isolation"}
        onClose={close}
        anchorRef={anchors.isolation}
        rootRef={rootRef}
        title="Isolation"
        searchPlaceholder="Search..."
        options={options.isolations}
        onSelect={selectIsolation}
        emptyText="No options."
      />
      <Dropdown
        theme={theme}
        compact={compact}
        open={open === "profile"}
        onClose={close}
        anchorRef={anchors.profile}
        rootRef={rootRef}
        title="Container profile"
        searchPlaceholder="Search profiles"
        options={options.profiles}
        onSelect={form.setProfileId}
        footer={options.profileActions}
        onFooterSelect={editProfiles}
        emptyText="No profiles."
        minWidth={320}
      />
      <Dropdown
        theme={theme}
        compact={compact}
        open={open === "ref"}
        onClose={close}
        anchorRef={anchors.ref}
        rootRef={rootRef}
        title="Start from"
        searchPlaceholder="Search branches"
        options={options.refs}
        onSelect={form.setBaseRef}
        emptyText="No matching refs."
      />
    </>
  );
}

function useProfileEditing(form: SandboxForm) {
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<ProfileEditorTarget | null>(null);
  const open = useCallback(
    (action: string) => {
      const { profiles, defaultId } = form.lists.profiles;
      if (action === EDIT_PROFILE && form.profile) {
        setTarget({
          mode: "edit",
          profile: form.profile,
          isDefault: form.profile.id === defaultId,
          canDelete: profiles.length > 1,
        });
        return;
      }
      setTarget({ mode: "new", ...(form.profile ? { from: form.profile } : {}) });
    },
    [form.lists.profiles, form.profile],
  );
  const close = useCallback(() => setTarget(null), []);
  const saved = useCallback(
    (profile: ContainerProfile | null) => {
      setTarget(null);
      form.setProfileId(profile?.id ?? null);
      void queryClient.invalidateQueries({ queryKey: ["container-profiles"] });
    },
    [form, queryClient],
  );
  return { target, open, close, saved };
}

function useScreenStyles(theme: PluginTheme, compact: boolean) {
  return useMemo(
    () => ({
      root: { flex: 1, backgroundColor: theme.colors.surface0 },
      centered: {
        flex: 1,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        paddingBottom: 60,
      },
      form: { width: "100%" as const, maxWidth: 820 },
      titleBox: { marginBottom: 32, paddingLeft: 24, paddingRight: 16 },
      title: {
        fontSize: FONT.title,
        fontWeight: "normal" as const,
        color: theme.colors.foreground,
      },
      badgeRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        minHeight: 28,
        marginBottom: 16,
        paddingHorizontal: 16,
        gap: 8,
      },
      spacer: { flex: 1 },
      fieldStack: { marginBottom: 16, paddingHorizontal: 16, gap: 8 },
      composerBox: { paddingHorizontal: 16, paddingBottom: compact ? 16 : 0 },
      note: {
        marginTop: 8,
        paddingHorizontal: 4,
        fontSize: FONT.sm,
        color: theme.colors.foregroundMuted,
      },
      error: {
        marginTop: 8,
        paddingHorizontal: 4,
        fontSize: FONT.base,
        lineHeight: 20,
        color: theme.colors.statusDanger,
      },
    }),
    [compact, theme],
  );
}

/**
 * Laid out like New workspace: the title, a row of field badges (a stack of fields on compact
 * layouts), and a composer that names the workspace. The workspace opens at once; agents and
 * terminals start from it and wait for its container as they launch.
 */
export function NewSandboxedWorkspaceScreen({
  theme,
  layout,
  params,
  navigation,
}: PluginScreenProps) {
  const compact = layout.compact;
  const navigate = navigation?.openWorkspace;
  const openWorkspace = useCallback(
    (workspaceId: string) => navigate?.({ workspaceId }),
    [navigate],
  );
  const form = useSandboxForm(params, openWorkspace);
  const editing = useProfileEditing(form);
  const rootRef = useRef<View>(null);
  const projectAnchor = useRef<View>(null);
  const isolationAnchor = useRef<View>(null);
  const profileAnchor = useRef<View>(null);
  const refAnchor = useRef<View>(null);
  const anchors = useMemo<Anchors>(
    () => ({
      project: projectAnchor,
      isolation: isolationAnchor,
      profile: profileAnchor,
      ref: refAnchor,
    }),
    [],
  );
  const [picker, setPicker] = useState<PickerKind | null>(null);
  const closePicker = useCallback(() => setPicker(null), []);
  const styles = useScreenStyles(theme, compact);

  if (form.lists.loading) return <Loading />;
  const composer = (
    <View style={styles.composerBox}>
      <PromptComposer theme={theme} compact={compact} form={form} />
      {form.project && form.isolation === "directory" ? (
        <Text style={styles.note}>
          {form.isGit ? "" : "Not a Git repository: "}The sandbox uses the project directory, which
          the project’s other workspaces share, so new agents started anywhere in it run in this
          sandbox.
        </Text>
      ) : null}
      {form.error ? <Text style={styles.error}>{form.error.message}</Text> : null}
    </View>
  );
  const fields = (
    <SetupFields
      theme={theme}
      compact={compact}
      form={form}
      anchors={anchors}
      openPicker={setPicker}
    />
  );
  return (
    <View ref={rootRef} collapsable={false} style={styles.root}>
      {compact ? (
        <>
          <View style={styles.spacer} />
          <View style={styles.fieldStack}>{fields}</View>
          {composer}
        </>
      ) : (
        <View style={styles.centered}>
          <View style={styles.form}>
            <View style={styles.titleBox}>
              <Text style={styles.title}>New sandboxed workspace</Text>
            </View>
            <View style={styles.badgeRow}>{fields}</View>
            {composer}
          </View>
        </View>
      )}
      <FormPickers
        theme={theme}
        compact={compact}
        form={form}
        anchors={anchors}
        rootRef={rootRef}
        open={picker}
        close={closePicker}
        editProfiles={editing.open}
      />
      <ProfileEditor target={editing.target} onClose={editing.close} onSaved={editing.saved} />
    </View>
  );
}
