CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  difficulty_band TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exercises (
  id TEXT PRIMARY KEY,
  prompt_md TEXT NOT NULL,
  starter_code TEXT,
  reference_solution TEXT NOT NULL,
  tests TEXT NOT NULL,
  difficulty_band TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  parent_exercise_id TEXT,
  FOREIGN KEY (parent_exercise_id) REFERENCES exercises(id)
);

CREATE TABLE IF NOT EXISTS exercise_topics (
  exercise_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  PRIMARY KEY (exercise_id, topic_id),
  FOREIGN KEY (exercise_id) REFERENCES exercises(id),
  FOREIGN KEY (topic_id) REFERENCES topics(id)
);

CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  exercise_id TEXT NOT NULL,
  submitted_code TEXT NOT NULL,
  passed INTEGER NOT NULL,
  per_attempt_score REAL NOT NULL,
  run_count INTEGER NOT NULL,
  recall_used_count INTEGER NOT NULL,
  chat_used_count INTEGER NOT NULL,
  time_spent_seconds INTEGER NOT NULL,
  examiner_review_md TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (exercise_id) REFERENCES exercises(id)
);

CREATE TABLE IF NOT EXISTS competence (
  topic_id TEXT PRIMARY KEY,
  score REAL NOT NULL,
  attempt_count INTEGER NOT NULL,
  last_updated INTEGER NOT NULL,
  FOREIGN KEY (topic_id) REFERENCES topics(id)
);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cost_cap_daily_usd REAL,
  cost_cap_monthly_usd REAL,
  models_json TEXT NOT NULL,
  preferred_topics_json TEXT,
  unlock_thresholds_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_spend (
  date TEXT PRIMARY KEY,
  estimated_usd REAL NOT NULL
);

INSERT OR IGNORE INTO settings (
  id,
  cost_cap_daily_usd,
  cost_cap_monthly_usd,
  models_json,
  preferred_topics_json,
  unlock_thresholds_json
) VALUES (
  1,
  NULL,
  NULL,
  '{}',
  NULL,
  '{"intermediate":0.8,"advanced":0.85}'
);
