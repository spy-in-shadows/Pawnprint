--
-- PostgreSQL database dump
--

\restrict y2l1sU6zGXQeUrdHqgmCcH4AEjjefFjv8da1kq9EwIukv4PzHZ5dtqUNa8ldkdA

-- Dumped from database version 16.15 (Debian 16.15-1.pgdg13+2)
-- Dumped by pg_dump version 16.15 (Debian 16.15-1.pgdg13+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account_phase_summary; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_phase_summary (
    player_account_id integer NOT NULL,
    phase_id integer NOT NULL,
    moves integer NOT NULL,
    blunders integer NOT NULL,
    avg_cp_loss double precision NOT NULL,
    CONSTRAINT account_phase_summary_avg_cp_loss_check CHECK ((avg_cp_loss >= (0)::double precision)),
    CONSTRAINT account_phase_summary_blunders_check CHECK ((blunders >= 0)),
    CONSTRAINT account_phase_summary_moves_check CHECK ((moves >= 0))
);


--
-- Name: account_summary; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_summary (
    player_account_id integer NOT NULL,
    total_games integer NOT NULL,
    analyzed_games integer NOT NULL,
    total_moves integer NOT NULL,
    inaccuracies integer NOT NULL,
    mistakes integer NOT NULL,
    blunders integer NOT NULL,
    avg_cp_loss double precision NOT NULL,
    accuracy_pct double precision NOT NULL,
    last_game_at timestamp(3) without time zone,
    refreshed_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT account_summary_accuracy_pct_check CHECK (((accuracy_pct >= (0)::double precision) AND (accuracy_pct <= (100)::double precision))),
    CONSTRAINT account_summary_analyzed_games_check CHECK ((analyzed_games >= 0)),
    CONSTRAINT account_summary_avg_cp_loss_check CHECK ((avg_cp_loss >= (0)::double precision)),
    CONSTRAINT account_summary_blunders_check CHECK ((blunders >= 0)),
    CONSTRAINT account_summary_inaccuracies_check CHECK ((inaccuracies >= 0)),
    CONSTRAINT account_summary_mistakes_check CHECK ((mistakes >= 0)),
    CONSTRAINT account_summary_total_games_check CHECK ((total_games >= 0)),
    CONSTRAINT account_summary_total_moves_check CHECK ((total_moves >= 0))
);


--
-- Name: analysis_job_games; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analysis_job_games (
    job_id integer NOT NULL,
    game_id integer NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    error text,
    CONSTRAINT analysis_job_games_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'analyzing'::text, 'done'::text, 'failed'::text])))
);


--
-- Name: analysis_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analysis_jobs (
    id integer NOT NULL,
    player_account_id integer NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    max_games integer DEFAULT 50 NOT NULL,
    since timestamp(3) without time zone,
    until timestamp(3) without time zone,
    locked_by text,
    locked_at timestamp(3) without time zone,
    heartbeat_at timestamp(3) without time zone,
    error text,
    failed_games integer DEFAULT 0 NOT NULL,
    skipped_games integer DEFAULT 0 NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    finished_at timestamp(3) without time zone,
    CONSTRAINT analysis_jobs_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT analysis_jobs_failed_games_check CHECK ((failed_games >= 0)),
    CONSTRAINT analysis_jobs_max_games_check CHECK ((max_games > 0)),
    CONSTRAINT analysis_jobs_since_until_check CHECK (((since IS NULL) OR (until IS NULL) OR (since <= until))),
    CONSTRAINT analysis_jobs_skipped_games_check CHECK ((skipped_games >= 0)),
    CONSTRAINT analysis_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'failed'::text])))
);


--
-- Name: analysis_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.analysis_jobs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: analysis_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.analysis_jobs_id_seq OWNED BY public.analysis_jobs.id;


--
-- Name: classifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.classifications (
    id integer NOT NULL,
    name text NOT NULL
);


--
-- Name: classifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.classifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: classifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.classifications_id_seq OWNED BY public.classifications.id;


--
-- Name: engine_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.engine_versions (
    id integer NOT NULL,
    name text NOT NULL,
    version text NOT NULL,
    default_depth integer NOT NULL,
    threads integer DEFAULT 1 NOT NULL,
    hash_size integer DEFAULT 64 NOT NULL,
    CONSTRAINT engine_versions_default_depth_check CHECK ((default_depth > 0)),
    CONSTRAINT engine_versions_hash_size_check CHECK ((hash_size > 0)),
    CONSTRAINT engine_versions_threads_check CHECK ((threads > 0))
);


--
-- Name: engine_versions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.engine_versions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: engine_versions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.engine_versions_id_seq OWNED BY public.engine_versions.id;


--
-- Name: games; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.games (
    id integer NOT NULL,
    player_account_id integer NOT NULL,
    platform_id integer NOT NULL,
    external_id text NOT NULL,
    played_at timestamp(3) without time zone NOT NULL,
    color text NOT NULL,
    result_id integer NOT NULL,
    opening_id integer,
    time_control_id integer,
    player_rating integer,
    opponent_rating integer,
    total_plies integer NOT NULL,
    analysis_status text DEFAULT 'pending'::text NOT NULL,
    failure_reason text,
    CONSTRAINT games_analysis_status_check CHECK ((analysis_status = ANY (ARRAY['pending'::text, 'analyzed'::text, 'failed'::text]))),
    CONSTRAINT games_color_check CHECK ((color = ANY (ARRAY['white'::text, 'black'::text]))),
    CONSTRAINT games_opponent_rating_check CHECK (((opponent_rating IS NULL) OR (opponent_rating >= 0))),
    CONSTRAINT games_player_rating_check CHECK (((player_rating IS NULL) OR (player_rating >= 0))),
    CONSTRAINT games_total_plies_check CHECK ((total_plies >= 0))
);


--
-- Name: games_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.games_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: games_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.games_id_seq OWNED BY public.games.id;


--
-- Name: motifs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.motifs (
    id integer NOT NULL,
    name text NOT NULL
);


--
-- Name: motifs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.motifs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: motifs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.motifs_id_seq OWNED BY public.motifs.id;


--
-- Name: move_classifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.move_classifications (
    move_id integer NOT NULL,
    classification_id integer NOT NULL,
    cp_loss integer NOT NULL,
    CONSTRAINT move_classifications_cp_loss_check CHECK ((cp_loss >= 0))
);


--
-- Name: move_evals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.move_evals (
    move_id integer NOT NULL,
    eval_before_cp integer NOT NULL,
    eval_after_cp integer NOT NULL,
    best_uci text NOT NULL,
    depth integer NOT NULL,
    engine_version_id integer NOT NULL,
    CONSTRAINT move_evals_depth_check CHECK ((depth >= 0))
);


--
-- Name: move_mates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.move_mates (
    move_id integer NOT NULL,
    mate_before integer,
    mate_after integer
);


--
-- Name: move_motifs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.move_motifs (
    move_id integer NOT NULL,
    motif_id integer NOT NULL,
    kind text DEFAULT 'allowed'::text NOT NULL,
    CONSTRAINT move_motifs_kind_check CHECK ((kind = ANY (ARRAY['allowed'::text, 'missed'::text])))
);


--
-- Name: moves; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.moves (
    id integer NOT NULL,
    game_id integer NOT NULL,
    ply integer NOT NULL,
    san text NOT NULL,
    uci text NOT NULL,
    fen_before text NOT NULL,
    mover_color text NOT NULL,
    clock_remaining_ms integer,
    time_spent_ms integer,
    phase_id integer NOT NULL,
    CONSTRAINT moves_clock_remaining_ms_check CHECK (((clock_remaining_ms IS NULL) OR (clock_remaining_ms >= 0))),
    CONSTRAINT moves_mover_color_check CHECK ((mover_color = ANY (ARRAY['white'::text, 'black'::text]))),
    CONSTRAINT moves_ply_check CHECK ((ply > 0)),
    CONSTRAINT moves_time_spent_ms_check CHECK (((time_spent_ms IS NULL) OR (time_spent_ms >= 0)))
);


--
-- Name: moves_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.moves_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: moves_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.moves_id_seq OWNED BY public.moves.id;


--
-- Name: openings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.openings (
    id integer NOT NULL,
    eco text NOT NULL,
    name text NOT NULL
);


--
-- Name: openings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.openings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: openings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.openings_id_seq OWNED BY public.openings.id;


--
-- Name: phases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.phases (
    id integer NOT NULL,
    name text NOT NULL
);


--
-- Name: phases_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.phases_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: phases_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.phases_id_seq OWNED BY public.phases.id;


--
-- Name: platforms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platforms (
    id integer NOT NULL,
    name text NOT NULL
);


--
-- Name: platforms_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.platforms_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: platforms_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.platforms_id_seq OWNED BY public.platforms.id;


--
-- Name: player_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.player_accounts (
    id integer NOT NULL,
    user_id integer NOT NULL,
    platform_id integer NOT NULL,
    username text NOT NULL,
    last_synced_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: player_accounts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.player_accounts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: player_accounts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.player_accounts_id_seq OWNED BY public.player_accounts.id;


--
-- Name: puzzle_motifs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.puzzle_motifs (
    puzzle_id integer NOT NULL,
    motif_id integer NOT NULL
);


--
-- Name: puzzles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.puzzles (
    id integer NOT NULL,
    lichess_id text NOT NULL,
    fen text NOT NULL,
    moves_uci text NOT NULL,
    rating integer NOT NULL,
    phase_tag text,
    CONSTRAINT puzzles_rating_check CHECK ((rating > 0))
);


--
-- Name: puzzles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.puzzles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: puzzles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.puzzles_id_seq OWNED BY public.puzzles.id;


--
-- Name: results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.results (
    id integer NOT NULL,
    code text NOT NULL
);


--
-- Name: results_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.results_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: results_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.results_id_seq OWNED BY public.results.id;


--
-- Name: time_controls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.time_controls (
    id integer NOT NULL,
    base_seconds integer NOT NULL,
    increment_seconds integer NOT NULL,
    category text NOT NULL,
    CONSTRAINT time_controls_base_seconds_check CHECK ((base_seconds >= 0)),
    CONSTRAINT time_controls_category_check CHECK ((category = ANY (ARRAY['bullet'::text, 'blitz'::text, 'rapid'::text, 'classical'::text, 'correspondence'::text]))),
    CONSTRAINT time_controls_increment_seconds_check CHECK ((increment_seconds >= 0))
);


--
-- Name: time_controls_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.time_controls_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: time_controls_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.time_controls_id_seq OWNED BY public.time_controls.id;


--
-- Name: training_plan_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.training_plan_items (
    id integer NOT NULL,
    plan_id integer NOT NULL,
    puzzle_id integer NOT NULL,
    motif_id integer,
    reason_code text NOT NULL,
    completed_at timestamp(3) without time zone
);


--
-- Name: training_plan_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.training_plan_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: training_plan_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.training_plan_items_id_seq OWNED BY public.training_plan_items.id;


--
-- Name: training_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.training_plans (
    id integer NOT NULL,
    user_id integer NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: training_plans_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.training_plans_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: training_plans_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.training_plans_id_seq OWNED BY public.training_plans.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id integer NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: analysis_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_jobs ALTER COLUMN id SET DEFAULT nextval('public.analysis_jobs_id_seq'::regclass);


--
-- Name: classifications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.classifications ALTER COLUMN id SET DEFAULT nextval('public.classifications_id_seq'::regclass);


--
-- Name: engine_versions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.engine_versions ALTER COLUMN id SET DEFAULT nextval('public.engine_versions_id_seq'::regclass);


--
-- Name: games id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.games ALTER COLUMN id SET DEFAULT nextval('public.games_id_seq'::regclass);


--
-- Name: motifs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.motifs ALTER COLUMN id SET DEFAULT nextval('public.motifs_id_seq'::regclass);


--
-- Name: moves id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.moves ALTER COLUMN id SET DEFAULT nextval('public.moves_id_seq'::regclass);


--
-- Name: openings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.openings ALTER COLUMN id SET DEFAULT nextval('public.openings_id_seq'::regclass);


--
-- Name: phases id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phases ALTER COLUMN id SET DEFAULT nextval('public.phases_id_seq'::regclass);


--
-- Name: platforms id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platforms ALTER COLUMN id SET DEFAULT nextval('public.platforms_id_seq'::regclass);


--
-- Name: player_accounts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.player_accounts ALTER COLUMN id SET DEFAULT nextval('public.player_accounts_id_seq'::regclass);


--
-- Name: puzzles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.puzzles ALTER COLUMN id SET DEFAULT nextval('public.puzzles_id_seq'::regclass);


--
-- Name: results id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.results ALTER COLUMN id SET DEFAULT nextval('public.results_id_seq'::regclass);


--
-- Name: time_controls id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_controls ALTER COLUMN id SET DEFAULT nextval('public.time_controls_id_seq'::regclass);


--
-- Name: training_plan_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_plan_items ALTER COLUMN id SET DEFAULT nextval('public.training_plan_items_id_seq'::regclass);


--
-- Name: training_plans id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_plans ALTER COLUMN id SET DEFAULT nextval('public.training_plans_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: account_phase_summary account_phase_summary_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_phase_summary
    ADD CONSTRAINT account_phase_summary_pkey PRIMARY KEY (player_account_id, phase_id);


--
-- Name: account_summary account_summary_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_summary
    ADD CONSTRAINT account_summary_pkey PRIMARY KEY (player_account_id);


--
-- Name: analysis_job_games analysis_job_games_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_job_games
    ADD CONSTRAINT analysis_job_games_pkey PRIMARY KEY (job_id, game_id);


--
-- Name: analysis_jobs analysis_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_jobs
    ADD CONSTRAINT analysis_jobs_pkey PRIMARY KEY (id);


--
-- Name: classifications classifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.classifications
    ADD CONSTRAINT classifications_pkey PRIMARY KEY (id);


--
-- Name: engine_versions engine_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.engine_versions
    ADD CONSTRAINT engine_versions_pkey PRIMARY KEY (id);


--
-- Name: games games_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.games
    ADD CONSTRAINT games_pkey PRIMARY KEY (id);


--
-- Name: motifs motifs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.motifs
    ADD CONSTRAINT motifs_pkey PRIMARY KEY (id);


--
-- Name: move_classifications move_classifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.move_classifications
    ADD CONSTRAINT move_classifications_pkey PRIMARY KEY (move_id);


--
-- Name: move_evals move_evals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.move_evals
    ADD CONSTRAINT move_evals_pkey PRIMARY KEY (move_id);


--
-- Name: move_mates move_mates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.move_mates
    ADD CONSTRAINT move_mates_pkey PRIMARY KEY (move_id);


--
-- Name: move_motifs move_motifs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.move_motifs
    ADD CONSTRAINT move_motifs_pkey PRIMARY KEY (move_id, motif_id, kind);


--
-- Name: moves moves_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.moves
    ADD CONSTRAINT moves_pkey PRIMARY KEY (id);


--
-- Name: openings openings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.openings
    ADD CONSTRAINT openings_pkey PRIMARY KEY (id);


--
-- Name: phases phases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phases
    ADD CONSTRAINT phases_pkey PRIMARY KEY (id);


--
-- Name: platforms platforms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platforms
    ADD CONSTRAINT platforms_pkey PRIMARY KEY (id);


--
-- Name: player_accounts player_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.player_accounts
    ADD CONSTRAINT player_accounts_pkey PRIMARY KEY (id);


--
-- Name: puzzle_motifs puzzle_motifs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.puzzle_motifs
    ADD CONSTRAINT puzzle_motifs_pkey PRIMARY KEY (puzzle_id, motif_id);


--
-- Name: puzzles puzzles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.puzzles
    ADD CONSTRAINT puzzles_pkey PRIMARY KEY (id);


--
-- Name: results results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.results
    ADD CONSTRAINT results_pkey PRIMARY KEY (id);


--
-- Name: time_controls time_controls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_controls
    ADD CONSTRAINT time_controls_pkey PRIMARY KEY (id);


--
-- Name: training_plan_items training_plan_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_plan_items
    ADD CONSTRAINT training_plan_items_pkey PRIMARY KEY (id);


--
-- Name: training_plans training_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_plans
    ADD CONSTRAINT training_plans_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: analysis_jobs_status_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analysis_jobs_status_created_at_idx ON public.analysis_jobs USING btree (status, created_at);


--
-- Name: classifications_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX classifications_name_key ON public.classifications USING btree (name);


--
-- Name: engine_versions_name_version_default_depth_threads_hash_siz_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX engine_versions_name_version_default_depth_threads_hash_siz_key ON public.engine_versions USING btree (name, version, default_depth, threads, hash_size);


--
-- Name: games_platform_id_external_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX games_platform_id_external_id_key ON public.games USING btree (platform_id, external_id);


--
-- Name: games_player_account_id_played_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX games_player_account_id_played_at_idx ON public.games USING btree (player_account_id, played_at);


--
-- Name: idx_analysis_jobs_active_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_analysis_jobs_active_unique ON public.analysis_jobs USING btree (player_account_id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));


--
-- Name: idx_move_motifs_motif_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_move_motifs_motif_id ON public.move_motifs USING btree (motif_id);


--
-- Name: idx_player_accounts_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_player_accounts_user_id ON public.player_accounts USING btree (user_id);


--
-- Name: motifs_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX motifs_name_key ON public.motifs USING btree (name);


--
-- Name: moves_game_id_ply_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX moves_game_id_ply_key ON public.moves USING btree (game_id, ply);


--
-- Name: openings_eco_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX openings_eco_name_key ON public.openings USING btree (eco, name);


--
-- Name: phases_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX phases_name_key ON public.phases USING btree (name);


--
-- Name: platforms_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX platforms_name_key ON public.platforms USING btree (name);


--
-- Name: player_accounts_platform_id_username_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX player_accounts_platform_id_username_key ON public.player_accounts USING btree (platform_id, username);


--
-- Name: puzzles_lichess_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX puzzles_lichess_id_key ON public.puzzles USING btree (lichess_id);


--
-- Name: results_code_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX results_code_key ON public.results USING btree (code);


--
-- Name: time_controls_base_seconds_increment_seconds_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX time_controls_base_seconds_increment_seconds_key ON public.time_controls USING btree (base_seconds, increment_seconds);


--
-- Name: users_email_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_email_key ON public.users USING btree (email);


--
-- Name: account_phase_summary account_phase_summary_phase_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_phase_summary
    ADD CONSTRAINT account_phase_summary_phase_id_fkey FOREIGN KEY (phase_id) REFERENCES public.phases(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: account_phase_summary account_phase_summary_player_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_phase_summary
    ADD CONSTRAINT account_phase_summary_player_account_id_fkey FOREIGN KEY (player_account_id) REFERENCES public.player_accounts(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: account_summary account_summary_player_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_summary
    ADD CONSTRAINT account_summary_player_account_id_fkey FOREIGN KEY (player_account_id) REFERENCES public.player_accounts(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: analysis_job_games analysis_job_games_game_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_job_games
    ADD CONSTRAINT analysis_job_games_game_id_fkey FOREIGN KEY (game_id) REFERENCES public.games(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: analysis_job_games analysis_job_games_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_job_games
    ADD CONSTRAINT analysis_job_games_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.analysis_jobs(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: analysis_jobs analysis_jobs_player_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_jobs
    ADD CONSTRAINT analysis_jobs_player_account_id_fkey FOREIGN KEY (player_account_id) REFERENCES public.player_accounts(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: games games_opening_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.games
    ADD CONSTRAINT games_opening_id_fkey FOREIGN KEY (opening_id) REFERENCES public.openings(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: games games_platform_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.games
    ADD CONSTRAINT games_platform_id_fkey FOREIGN KEY (platform_id) REFERENCES public.platforms(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: games games_player_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.games
    ADD CONSTRAINT games_player_account_id_fkey FOREIGN KEY (player_account_id) REFERENCES public.player_accounts(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: games games_result_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.games
    ADD CONSTRAINT games_result_id_fkey FOREIGN KEY (result_id) REFERENCES public.results(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: games games_time_control_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.games
    ADD CONSTRAINT games_time_control_id_fkey FOREIGN KEY (time_control_id) REFERENCES public.time_controls(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: move_classifications move_classifications_classification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.move_classifications
    ADD CONSTRAINT move_classifications_classification_id_fkey FOREIGN KEY (classification_id) REFERENCES public.classifications(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: move_classifications move_classifications_move_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.move_classifications
    ADD CONSTRAINT move_classifications_move_id_fkey FOREIGN KEY (move_id) REFERENCES public.moves(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: move_evals move_evals_engine_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.move_evals
    ADD CONSTRAINT move_evals_engine_version_id_fkey FOREIGN KEY (engine_version_id) REFERENCES public.engine_versions(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: move_evals move_evals_move_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.move_evals
    ADD CONSTRAINT move_evals_move_id_fkey FOREIGN KEY (move_id) REFERENCES public.moves(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: move_mates move_mates_move_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.move_mates
    ADD CONSTRAINT move_mates_move_id_fkey FOREIGN KEY (move_id) REFERENCES public.moves(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: move_motifs move_motifs_motif_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.move_motifs
    ADD CONSTRAINT move_motifs_motif_id_fkey FOREIGN KEY (motif_id) REFERENCES public.motifs(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: move_motifs move_motifs_move_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.move_motifs
    ADD CONSTRAINT move_motifs_move_id_fkey FOREIGN KEY (move_id) REFERENCES public.moves(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: moves moves_game_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.moves
    ADD CONSTRAINT moves_game_id_fkey FOREIGN KEY (game_id) REFERENCES public.games(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: moves moves_phase_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.moves
    ADD CONSTRAINT moves_phase_id_fkey FOREIGN KEY (phase_id) REFERENCES public.phases(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: player_accounts player_accounts_platform_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.player_accounts
    ADD CONSTRAINT player_accounts_platform_id_fkey FOREIGN KEY (platform_id) REFERENCES public.platforms(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: player_accounts player_accounts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.player_accounts
    ADD CONSTRAINT player_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: puzzle_motifs puzzle_motifs_motif_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.puzzle_motifs
    ADD CONSTRAINT puzzle_motifs_motif_id_fkey FOREIGN KEY (motif_id) REFERENCES public.motifs(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: puzzle_motifs puzzle_motifs_puzzle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.puzzle_motifs
    ADD CONSTRAINT puzzle_motifs_puzzle_id_fkey FOREIGN KEY (puzzle_id) REFERENCES public.puzzles(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: training_plan_items training_plan_items_motif_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_plan_items
    ADD CONSTRAINT training_plan_items_motif_id_fkey FOREIGN KEY (motif_id) REFERENCES public.motifs(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: training_plan_items training_plan_items_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_plan_items
    ADD CONSTRAINT training_plan_items_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.training_plans(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: training_plan_items training_plan_items_puzzle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_plan_items
    ADD CONSTRAINT training_plan_items_puzzle_id_fkey FOREIGN KEY (puzzle_id) REFERENCES public.puzzles(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: training_plans training_plans_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_plans
    ADD CONSTRAINT training_plans_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict y2l1sU6zGXQeUrdHqgmCcH4AEjjefFjv8da1kq9EwIukv4PzHZ5dtqUNa8ldkdA

