
CREATE TABLE IF NOT EXISTS plan_calendar_enrollments(
 enrollment_id TEXT PRIMARY KEY REFERENCES plan_enrollments(id),
 start_date TEXT NOT NULL CHECK(start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
 schedule_mode TEXT NOT NULL CHECK(schedule_mode IN ('calendar-aligned','day-one'))
);
CREATE TABLE IF NOT EXISTS plan_calendar_assignments(
 id TEXT PRIMARY KEY,
 enrollment_id TEXT NOT NULL REFERENCES plan_calendar_enrollments(enrollment_id),
 definition_version_id TEXT NOT NULL REFERENCES plan_definition_versions(id),
 definition_day INTEGER NOT NULL CHECK(definition_day>0),
 local_date TEXT NOT NULL CHECK(local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
 passages TEXT NOT NULL CHECK(json_valid(passages) AND json_type(passages)='array' AND json_array_length(passages)>0),
 UNIQUE(enrollment_id,definition_day),
 UNIQUE(enrollment_id,local_date)
);
CREATE TABLE IF NOT EXISTS plan_calendar_completions(
 id TEXT PRIMARY KEY,
 assignment_id TEXT NOT NULL REFERENCES plan_calendar_assignments(id),
 enrollment_id TEXT NOT NULL REFERENCES plan_calendar_enrollments(enrollment_id),
 completed_at TEXT NOT NULL,
 FOREIGN KEY(assignment_id,enrollment_id) REFERENCES plan_calendar_assignments(id,enrollment_id)
);
CREATE TABLE IF NOT EXISTS plan_calendar_completion_undos(
 id TEXT PRIMARY KEY,
 completion_id TEXT NOT NULL UNIQUE REFERENCES plan_calendar_completions(id),
 enrollment_id TEXT NOT NULL,
 assignment_id TEXT NOT NULL,
 undone_at TEXT NOT NULL,
 FOREIGN KEY(assignment_id,enrollment_id) REFERENCES plan_calendar_assignments(id,enrollment_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS plan_calendar_assignment_owner ON plan_calendar_assignments(id,enrollment_id);
CREATE TRIGGER IF NOT EXISTS plan_calendar_enrollments_immutable BEFORE UPDATE ON plan_calendar_enrollments
BEGIN SELECT RAISE(ABORT,'Calendar enrollments are immutable'); END;
CREATE TRIGGER IF NOT EXISTS plan_calendar_enrollments_retained BEFORE DELETE ON plan_calendar_enrollments
BEGIN SELECT RAISE(ABORT,'Plan progress is retained'); END;
CREATE TRIGGER IF NOT EXISTS plan_calendar_assignments_immutable BEFORE UPDATE ON plan_calendar_assignments
BEGIN SELECT RAISE(ABORT,'Calendar assignments are immutable'); END;
CREATE TRIGGER IF NOT EXISTS plan_calendar_assignments_retained BEFORE DELETE ON plan_calendar_assignments
BEGIN SELECT RAISE(ABORT,'Plan progress is retained'); END;
CREATE TRIGGER IF NOT EXISTS plan_calendar_completions_immutable BEFORE UPDATE ON plan_calendar_completions
BEGIN SELECT RAISE(ABORT,'Calendar completions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS plan_calendar_completions_retained BEFORE DELETE ON plan_calendar_completions
BEGIN SELECT RAISE(ABORT,'Plan progress is retained'); END;
CREATE TRIGGER IF NOT EXISTS plan_calendar_completion_active BEFORE INSERT ON plan_calendar_completions
WHEN EXISTS(SELECT 1 FROM plan_calendar_completions c WHERE c.assignment_id=NEW.assignment_id AND NOT EXISTS(SELECT 1 FROM plan_calendar_completion_undos u WHERE u.completion_id=c.id))
BEGIN SELECT RAISE(ABORT,'Calendar assignment already has an active completion'); END;
CREATE TRIGGER IF NOT EXISTS plan_calendar_completion_undos_immutable BEFORE UPDATE ON plan_calendar_completion_undos
BEGIN SELECT RAISE(ABORT,'Calendar completion undos are immutable'); END;
CREATE TRIGGER IF NOT EXISTS plan_calendar_completion_undos_retained BEFORE DELETE ON plan_calendar_completion_undos
BEGIN SELECT RAISE(ABORT,'Plan progress is retained'); END;
CREATE TRIGGER IF NOT EXISTS plan_calendar_completion_undos_match BEFORE INSERT ON plan_calendar_completion_undos
WHEN NOT EXISTS(SELECT 1 FROM plan_calendar_completions c WHERE c.id=NEW.completion_id AND c.assignment_id=NEW.assignment_id AND c.enrollment_id=NEW.enrollment_id)
BEGIN SELECT RAISE(ABORT,'Calendar undo must match completion ownership'); END;
CREATE TRIGGER IF NOT EXISTS plan_calendar_assignments_match BEFORE INSERT ON plan_calendar_assignments
WHEN NOT EXISTS(
 SELECT 1 FROM plan_enrollments e
 JOIN plan_calendar_enrollments c ON c.enrollment_id=e.id
 JOIN plan_definition_versions v ON v.id=e.definition_version_id
 WHERE e.id=NEW.enrollment_id
 AND e.definition_version_id=NEW.definition_version_id
 AND json_extract(v.definition,'$.schedule.kind')='explicitSchedule'
 AND json_extract(v.definition,'$.schedule.days['||(NEW.definition_day-1)||'].day')=NEW.definition_day
 AND json_extract(v.definition,'$.schedule.days['||(NEW.definition_day-1)||'].passages')=json(NEW.passages)
)
BEGIN SELECT RAISE(ABORT,'Calendar assignment must belong to its enrollment version'); END;
