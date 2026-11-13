
/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `academic_calendar_setting` (
  `setting_key` varchar(60) NOT NULL,
  `setting_value` varchar(60) NOT NULL,
  `description` varchar(255) NOT NULL,
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`setting_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `academic_term` (
  `term_id` int(11) NOT NULL AUTO_INCREMENT,
  `school_year_id` int(11) NOT NULL,
  `semester_id` int(11) NOT NULL,
  `period` tinyint(3) unsigned NOT NULL COMMENT '1, 2 or 3 -- the periodical this window covers',
  `starts_on` date NOT NULL,
  `ends_on` date NOT NULL COMMENT 'Inclusive. A period that ends on the 12th includes the 12th.',
  `created_by_user_id` int(11) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`term_id`),
  UNIQUE KEY `uq_academic_term_scope` (`school_year_id`,`semester_id`,`period`),
  KEY `idx_academic_term_window` (`starts_on`,`ends_on`),
  KEY `fk_academic_term_semester` (`semester_id`),
  KEY `fk_academic_term_user` (`created_by_user_id`),
  CONSTRAINT `fk_academic_term_semester` FOREIGN KEY (`semester_id`) REFERENCES `semester` (`semester_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_academic_term_user` FOREIGN KEY (`created_by_user_id`) REFERENCES `user` (`user_id`) ON DELETE SET NULL,
  CONSTRAINT `fk_academic_term_year` FOREIGN KEY (`school_year_id`) REFERENCES `school_year` (`school_year_id`) ON DELETE CASCADE,
  CONSTRAINT `chk_academic_term_period` CHECK (`period` between 1 and 3),
  CONSTRAINT `chk_academic_term_order` CHECK (`ends_on` >= `starts_on`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `api_audit_log` (
  `audit_id` bigint(20) NOT NULL AUTO_INCREMENT,
  `occurred_at` datetime NOT NULL DEFAULT current_timestamp(),
  `user_id` int(11) DEFAULT NULL,
  `actor_label` varchar(190) DEFAULT NULL,
  `action` varchar(60) NOT NULL,
  `outcome` varchar(20) NOT NULL DEFAULT 'success',
  `detail` varchar(255) DEFAULT NULL,
  `ip_address` varchar(45) DEFAULT NULL,
  `device` varchar(120) DEFAULT NULL,
  `user_agent` varchar(255) DEFAULT NULL,
  `metadata` text DEFAULT NULL COMMENT 'The event as structured JSON. Prose belongs in detail.',
  PRIMARY KEY (`audit_id`),
  KEY `idx_audit_occurred` (`occurred_at`),
  KEY `idx_audit_user` (`user_id`),
  KEY `idx_audit_action` (`action`),
  KEY `idx_audit_ip` (`ip_address`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `api_rate_limits` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `identity_key` varchar(255) NOT NULL,
  `action_type` varchar(50) NOT NULL,
  `attempt_count` int(11) NOT NULL DEFAULT 1,
  `first_attempt_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `last_attempt_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `locked_until` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_rate_limits_identity` (`identity_key`,`action_type`),
  KEY `idx_rate_limits_locked` (`locked_until`),
  KEY `idx_rate_limits_last_attempt` (`last_attempt_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `attendance` (
  `attendance_id` int(11) NOT NULL AUTO_INCREMENT,
  `student_id` int(11) NOT NULL,
  `semester_id` int(11) NOT NULL,
  `schoolyear_id` int(11) NOT NULL,
  `period` tinyint(3) unsigned DEFAULT NULL COMMENT 'Grading period 1-3. NULL = legacy term total.',
  `total_classes_conducted` int(11) NOT NULL DEFAULT 0,
  `present` int(11) NOT NULL DEFAULT 0,
  `absent` int(11) NOT NULL DEFAULT 0,
  `upload_id` int(11) DEFAULT NULL COMMENT 'The upload that last wrote this row',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `period_key` tinyint(3) unsigned GENERATED ALWAYS AS (coalesce(`period`,0)) STORED COMMENT 'period, with 0 standing in for NULL so the unique key can compare it',
  PRIMARY KEY (`attendance_id`),
  UNIQUE KEY `uq_attendance_student_term_pkey` (`student_id`,`semester_id`,`schoolyear_id`,`period_key`),
  KEY `semester_id` (`semester_id`),
  KEY `schoolyear_id` (`schoolyear_id`),
  KEY `idx_attendance_upload` (`upload_id`),
  CONSTRAINT `attendance_fk_schoolyear` FOREIGN KEY (`schoolyear_id`) REFERENCES `school_year` (`school_year_id`),
  CONSTRAINT `attendance_fk_semester` FOREIGN KEY (`semester_id`) REFERENCES `semester` (`semester_id`),
  CONSTRAINT `attendance_fk_student` FOREIGN KEY (`student_id`) REFERENCES `student` (`student_id`),
  CONSTRAINT `fk_attendance_upload` FOREIGN KEY (`upload_id`) REFERENCES `attendance_upload` (`upload_id`) ON DELETE SET NULL,
  CONSTRAINT `chk_attendance_counts_within_total` CHECK (`present` + `absent` <= `total_classes_conducted`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `attendance_remark_condition` (
  `condition_id` int(11) NOT NULL AUTO_INCREMENT,
  `rule_id` int(11) NOT NULL,
  `field_key` varchar(64) NOT NULL COMMENT 'absent | present | total_classes_conducted | attendance_rate | absence_rate | absences_over_target | meets_target',
  `operator` varchar(12) NOT NULL DEFAULT 'gte' COMMENT 'gte | gt | lte | lt | eq | between',
  `value_min` decimal(12,2) DEFAULT NULL,
  `value_max` decimal(12,2) DEFAULT NULL COMMENT 'Only read by `between`',
  PRIMARY KEY (`condition_id`),
  KEY `idx_attendance_remark_condition_rule` (`rule_id`),
  CONSTRAINT `fk_attendance_remark_condition_rule` FOREIGN KEY (`rule_id`) REFERENCES `attendance_remark_rule` (`rule_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `attendance_remark_policy` (
  `policy_id` int(11) NOT NULL AUTO_INCREMENT,
  `policy_name` varchar(120) NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `school_year_id` int(11) DEFAULT NULL COMMENT 'NULL = applies to any year with no policy of its own',
  `semester_id` int(11) DEFAULT NULL COMMENT 'NULL = every semester of that year',
  `period` tinyint(3) unsigned DEFAULT NULL COMMENT 'NULL = the semester total rather than one periodical',
  `target_max_absences` int(11) DEFAULT NULL COMMENT 'Most absences allowed in this scope. NULL = not part of the target.',
  `target_min_rate` decimal(5,2) DEFAULT NULL COMMENT 'Lowest attendance percent allowed. NULL = not part of the target.',
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_by_user_id` int(11) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`policy_id`),
  UNIQUE KEY `uq_attendance_remark_policy_name` (`policy_name`),
  KEY `idx_attendance_remark_policy_scope` (`school_year_id`,`semester_id`,`period`,`is_active`),
  KEY `fk_attendance_remark_policy_semester` (`semester_id`),
  KEY `fk_attendance_remark_policy_user` (`created_by_user_id`),
  CONSTRAINT `fk_attendance_remark_policy_semester` FOREIGN KEY (`semester_id`) REFERENCES `semester` (`semester_id`) ON DELETE SET NULL,
  CONSTRAINT `fk_attendance_remark_policy_user` FOREIGN KEY (`created_by_user_id`) REFERENCES `user` (`user_id`) ON DELETE SET NULL,
  CONSTRAINT `fk_attendance_remark_policy_year` FOREIGN KEY (`school_year_id`) REFERENCES `school_year` (`school_year_id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `attendance_remark_rule` (
  `rule_id` int(11) NOT NULL AUTO_INCREMENT,
  `policy_id` int(11) NOT NULL,
  `remark_id` int(11) NOT NULL,
  `label` varchar(120) NOT NULL,
  `sort_order` int(11) NOT NULL DEFAULT 0 COMMENT 'Lowest first. First matching rule wins.',
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (`rule_id`),
  KEY `idx_attendance_remark_rule_policy` (`policy_id`,`is_active`,`sort_order`),
  KEY `fk_attendance_remark_rule_remark` (`remark_id`),
  CONSTRAINT `fk_attendance_remark_rule_policy` FOREIGN KEY (`policy_id`) REFERENCES `attendance_remark_policy` (`policy_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_attendance_remark_rule_remark` FOREIGN KEY (`remark_id`) REFERENCES `remarks` (`remark_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `attendance_upload` (
  `upload_id` int(11) NOT NULL AUTO_INCREMENT,
  `uploaded_at` datetime NOT NULL DEFAULT current_timestamp(),
  `uploaded_by` int(11) DEFAULT NULL,
  `uploader_label` varchar(190) DEFAULT NULL COMMENT 'Who uploaded, as named then; kept if the account goes',
  `file_name` varchar(255) DEFAULT NULL COMMENT 'NULL when the upload predates tracking and the audit log did not name it',
  `semester_id` int(11) NOT NULL,
  `schoolyear_id` int(11) NOT NULL,
  `period` tinyint(3) unsigned DEFAULT NULL COMMENT 'As on attendance: 1-3, NULL = semester total',
  `rows_written` int(11) NOT NULL DEFAULT 0 COMMENT 'Rows this upload inserted or updated when it ran',
  PRIMARY KEY (`upload_id`),
  KEY `idx_attendance_upload_time` (`uploaded_at`),
  KEY `idx_attendance_upload_term` (`schoolyear_id`,`semester_id`,`period`),
  KEY `idx_attendance_upload_user` (`uploaded_by`),
  KEY `idx_attendance_upload_semester` (`semester_id`),
  CONSTRAINT `fk_attendance_upload_schoolyear` FOREIGN KEY (`schoolyear_id`) REFERENCES `school_year` (`school_year_id`),
  CONSTRAINT `fk_attendance_upload_semester` FOREIGN KEY (`semester_id`) REFERENCES `semester` (`semester_id`),
  CONSTRAINT `fk_attendance_upload_user` FOREIGN KEY (`uploaded_by`) REFERENCES `user` (`user_id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `audit_logs` (
  `audit_log_id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) DEFAULT NULL,
  `action` varchar(100) NOT NULL,
  `detail` text DEFAULT NULL,
  `email_snapshot` varchar(150) DEFAULT NULL,
  `role_id_snapshot` int(11) DEFAULT NULL,
  `role_name_snapshot` varchar(100) DEFAULT NULL,
  `metadata` longtext DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`audit_log_id`),
  KEY `idx_audit_logs_user_id` (`user_id`),
  KEY `idx_audit_logs_action` (`action`),
  KEY `idx_audit_logs_created_at` (`created_at`),
  CONSTRAINT `audit_logs_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `user` (`user_id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `auth_refresh_token` (
  `token_id` bigint(20) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) NOT NULL,
  `token_hash` char(64) NOT NULL,
  `family_id` char(32) NOT NULL,
  `issued_at` datetime NOT NULL DEFAULT current_timestamp(),
  `expires_at` datetime NOT NULL,
  `revoked_at` datetime DEFAULT NULL,
  `user_agent` varchar(190) DEFAULT NULL,
  PRIMARY KEY (`token_id`),
  UNIQUE KEY `uq_auth_refresh_token_hash` (`token_hash`),
  KEY `idx_auth_refresh_token_user` (`user_id`),
  KEY `idx_auth_refresh_token_family` (`family_id`),
  KEY `idx_auth_refresh_token_expires` (`expires_at`),
  CONSTRAINT `fk_auth_refresh_token_user` FOREIGN KEY (`user_id`) REFERENCES `user` (`user_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `batch` (
  `batch_id` int(11) NOT NULL AUTO_INCREMENT,
  `batch_name` varchar(100) DEFAULT NULL,
  `semester_id` int(11) DEFAULT NULL,
  PRIMARY KEY (`batch_id`),
  KEY `semester_id` (`semester_id`),
  CONSTRAINT `batch_ibfk_1` FOREIGN KEY (`semester_id`) REFERENCES `semester` (`semester_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `campus` (
  `campus_id` int(11) NOT NULL AUTO_INCREMENT,
  `campus_name` varchar(100) DEFAULT NULL,
  `campus_code` varchar(30) DEFAULT NULL,
  `address` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`campus_id`),
  UNIQUE KEY `campus_code` (`campus_code`),
  UNIQUE KEY `uq_campus_name` (`campus_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `coaching_unit` (
  `coaching_unit_id` int(11) NOT NULL AUTO_INCREMENT,
  `nsc_ksh_coach_name` varchar(100) DEFAULT NULL,
  `user_id` int(11) DEFAULT NULL,
  `type` varchar(50) DEFAULT NULL,
  PRIMARY KEY (`coaching_unit_id`),
  KEY `user_id` (`user_id`),
  CONSTRAINT `coaching_unit_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `contact_channel` (
  `channel_key` varchar(40) NOT NULL,
  `label` varchar(80) NOT NULL,
  `sort_order` int(11) NOT NULL DEFAULT 0,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `is_locked` tinyint(1) NOT NULL DEFAULT 0 COMMENT 'The code depends on this key: may be relabelled, never archived',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`channel_key`),
  KEY `idx_contact_channel_order` (`is_active`,`sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `contact_reason` (
  `reason_id` int(11) NOT NULL AUTO_INCREMENT,
  `category` varchar(40) NOT NULL COMMENT 'Financial, Personal, Health, Academics, System/Logistical, External Event, Others, Unreachable',
  `reason_text` varchar(190) NOT NULL,
  `sort_order` int(11) NOT NULL DEFAULT 0,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `needs_detail` tinyint(1) NOT NULL DEFAULT 0 COMMENT 'Picking this reason asks the caller to type what it was',
  PRIMARY KEY (`reason_id`),
  UNIQUE KEY `uq_contact_reason_text` (`reason_text`),
  KEY `idx_contact_reason_category` (`category`,`sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `contact_recovery_plan` (
  `plan_id` int(11) NOT NULL AUTO_INCREMENT,
  `plan_text` varchar(190) NOT NULL,
  `sort_order` int(11) NOT NULL DEFAULT 0,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`plan_id`),
  UNIQUE KEY `uq_contact_recovery_plan_text` (`plan_text`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `course` (
  `course_id` int(11) NOT NULL AUTO_INCREMENT,
  `course_name` varchar(100) DEFAULT NULL,
  `course_code` varchar(20) NOT NULL,
  `department_id` int(11) DEFAULT NULL,
  `archived_at` datetime DEFAULT NULL,
  `year_duration` tinyint(1) NOT NULL DEFAULT 4 COMMENT 'Number of year levels in this programme; caps student.year_level',
  PRIMARY KEY (`course_id`),
  UNIQUE KEY `uq_course_code_department` (`course_code`,`department_id`),
  KEY `department_id` (`department_id`),
  CONSTRAINT `course_ibfk_1` FOREIGN KEY (`department_id`) REFERENCES `department` (`department_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `department` (
  `department_id` int(11) NOT NULL AUTO_INCREMENT,
  `department_name` varchar(100) DEFAULT NULL,
  `department_code` varchar(20) NOT NULL,
  `campus_id` int(11) DEFAULT NULL,
  `archived_at` datetime DEFAULT NULL,
  PRIMARY KEY (`department_id`),
  UNIQUE KEY `uq_department_code_campus` (`department_code`,`campus_id`),
  KEY `campus_id` (`campus_id`),
  CONSTRAINT `department_ibfk_1` FOREIGN KEY (`campus_id`) REFERENCES `campus` (`campus_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `enrollment_status` (
  `enrollment_status_id` int(11) NOT NULL AUTO_INCREMENT,
  `status_type` int(11) DEFAULT NULL,
  `date` date DEFAULT NULL,
  `student_id` int(11) DEFAULT NULL,
  `decision` varchar(100) DEFAULT NULL,
  `response` text DEFAULT NULL,
  `semester_id` int(11) DEFAULT NULL,
  `reason` text DEFAULT NULL,
  `school_year_id` int(11) DEFAULT NULL,
  `archived_at` datetime DEFAULT NULL,
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`enrollment_status_id`),
  UNIQUE KEY `uq_enrollment_student_term` (`student_id`,`school_year_id`,`semester_id`),
  KEY `status_type` (`status_type`),
  KEY `student_id` (`student_id`),
  KEY `semester_id` (`semester_id`),
  KEY `school_year_id` (`school_year_id`),
  KEY `idx_enrollment_status_updated_at` (`updated_at`),
  CONSTRAINT `enrollment_status_ibfk_1` FOREIGN KEY (`status_type`) REFERENCES `status` (`status_id`),
  CONSTRAINT `enrollment_status_ibfk_2` FOREIGN KEY (`student_id`) REFERENCES `student` (`student_id`),
  CONSTRAINT `enrollment_status_ibfk_3` FOREIGN KEY (`semester_id`) REFERENCES `semester` (`semester_id`),
  CONSTRAINT `enrollment_status_ibfk_4` FOREIGN KEY (`school_year_id`) REFERENCES `school_year` (`school_year_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `finance` (
  `finance_id` int(11) NOT NULL AUTO_INCREMENT,
  `student_id` int(11) DEFAULT NULL,
  `semester_id` int(11) DEFAULT NULL,
  `balance_to_data` decimal(10,2) DEFAULT NULL,
  `balance_range` int(11) DEFAULT NULL,
  `date` date DEFAULT NULL,
  `school_year_id` int(11) DEFAULT NULL,
  `period` tinyint(3) unsigned DEFAULT NULL COMMENT 'Grading period 1-3. NULL = legacy / undated reading.',
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `period_key` tinyint(3) unsigned GENERATED ALWAYS AS (coalesce(`period`,0)) STORED COMMENT 'period, with 0 standing in for NULL so the unique key can compare it',
  PRIMARY KEY (`finance_id`),
  UNIQUE KEY `uq_finance_student_term_period` (`student_id`,`school_year_id`,`semester_id`,`period_key`),
  KEY `student_id` (`student_id`),
  KEY `semester_id` (`semester_id`),
  KEY `balance_range` (`balance_range`),
  KEY `school_year_id` (`school_year_id`),
  KEY `idx_finance_updated_at` (`updated_at`),
  CONSTRAINT `finance_ibfk_1` FOREIGN KEY (`student_id`) REFERENCES `student` (`student_id`),
  CONSTRAINT `finance_ibfk_2` FOREIGN KEY (`semester_id`) REFERENCES `semester` (`semester_id`),
  CONSTRAINT `finance_ibfk_3` FOREIGN KEY (`balance_range`) REFERENCES `status` (`status_id`),
  CONSTRAINT `finance_ibfk_4` FOREIGN KEY (`school_year_id`) REFERENCES `school_year` (`school_year_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `gender` (
  `name` varchar(20) NOT NULL,
  `sort_order` int(11) NOT NULL DEFAULT 0,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `is_locked` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`name`),
  KEY `idx_gender_order` (`is_active`,`sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `grade_remark_condition` (
  `condition_id` int(11) NOT NULL AUTO_INCREMENT,
  `rule_id` int(11) NOT NULL,
  `field_key` varchar(64) NOT NULL COMMENT 'failed | incomplete | no_credit | no_grade | passed | total_subject | pass_rate',
  `operator` varchar(12) NOT NULL DEFAULT 'gte' COMMENT 'gte | gt | lte | lt | eq | between',
  `value_min` decimal(12,2) DEFAULT NULL,
  `value_max` decimal(12,2) DEFAULT NULL COMMENT 'Only read by `between`',
  PRIMARY KEY (`condition_id`),
  KEY `idx_grade_remark_condition_rule` (`rule_id`),
  CONSTRAINT `fk_grade_remark_condition_rule` FOREIGN KEY (`rule_id`) REFERENCES `grade_remark_rule` (`rule_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `grade_remark_policy` (
  `policy_id` int(11) NOT NULL AUTO_INCREMENT,
  `policy_name` varchar(120) NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `school_year_id` int(11) DEFAULT NULL COMMENT 'NULL = applies to any year with no policy of its own',
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_by_user_id` int(11) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`policy_id`),
  UNIQUE KEY `uq_grade_remark_policy_name` (`policy_name`),
  KEY `idx_grade_remark_policy_year` (`school_year_id`,`is_active`),
  KEY `fk_grade_remark_policy_user` (`created_by_user_id`),
  CONSTRAINT `fk_grade_remark_policy_user` FOREIGN KEY (`created_by_user_id`) REFERENCES `user` (`user_id`) ON DELETE SET NULL,
  CONSTRAINT `fk_grade_remark_policy_year` FOREIGN KEY (`school_year_id`) REFERENCES `school_year` (`school_year_id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `grade_remark_rule` (
  `rule_id` int(11) NOT NULL AUTO_INCREMENT,
  `policy_id` int(11) NOT NULL,
  `remark_id` int(11) NOT NULL,
  `label` varchar(120) NOT NULL,
  `sort_order` int(11) NOT NULL DEFAULT 0 COMMENT 'Lowest first. First matching rule wins.',
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (`rule_id`),
  KEY `idx_grade_remark_rule_policy` (`policy_id`,`is_active`,`sort_order`),
  KEY `fk_grade_remark_rule_remark` (`remark_id`),
  CONSTRAINT `fk_grade_remark_rule_policy` FOREIGN KEY (`policy_id`) REFERENCES `grade_remark_policy` (`policy_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_grade_remark_rule_remark` FOREIGN KEY (`remark_id`) REFERENCES `remarks` (`remark_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `grades` (
  `grades_id` int(11) NOT NULL AUTO_INCREMENT,
  `student_id` int(11) NOT NULL,
  `semester_id` int(11) NOT NULL,
  `school_year_id` int(11) NOT NULL,
  `period` tinyint(3) unsigned DEFAULT NULL COMMENT 'Grading period 1-3. NULL = legacy term total.',
  `total_subject` int(11) DEFAULT NULL,
  `passed` int(11) DEFAULT NULL,
  `failed` int(11) DEFAULT NULL,
  `incomplete` int(11) DEFAULT NULL,
  `no_credit` int(11) DEFAULT 0,
  `no_grade` int(11) DEFAULT 0,
  `passed_of_subject` decimal(5,2) DEFAULT 0.00,
  `remark_id` int(11) DEFAULT NULL,
  `archived_at` datetime DEFAULT NULL,
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `period_key` tinyint(3) unsigned GENERATED ALWAYS AS (coalesce(`period`,0)) STORED COMMENT 'period, with 0 standing in for NULL so the unique key can compare it',
  PRIMARY KEY (`grades_id`),
  UNIQUE KEY `uq_grades_student_term_period` (`student_id`,`semester_id`,`school_year_id`,`period_key`),
  KEY `semester_id` (`semester_id`),
  KEY `school_year_id` (`school_year_id`),
  KEY `fk_grades_remark` (`remark_id`),
  KEY `idx_grades_term` (`school_year_id`,`semester_id`),
  KEY `idx_grades_updated_at` (`updated_at`),
  CONSTRAINT `fk_grades_remark` FOREIGN KEY (`remark_id`) REFERENCES `remarks` (`remark_id`),
  CONSTRAINT `grades_ibfk_1` FOREIGN KEY (`student_id`) REFERENCES `student` (`student_id`),
  CONSTRAINT `grades_ibfk_2` FOREIGN KEY (`semester_id`) REFERENCES `semester` (`semester_id`),
  CONSTRAINT `grades_ibfk_4` FOREIGN KEY (`school_year_id`) REFERENCES `school_year` (`school_year_id`),
  CONSTRAINT `chk_grades_counts_within_total` CHECK (coalesce(`passed`,0) + coalesce(`failed`,0) + coalesce(`incomplete`,0) + coalesce(`no_credit`,0) + coalesce(`no_grade`,0) <= `total_subject`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
SET @saved_cs_client     = @@character_set_client;
SET character_set_client = utf8;
/*!50001 CREATE VIEW `grades_with_pass_rate` AS SELECT
 1 AS `grades_id`,
  1 AS `student_id`,
  1 AS `semester_id`,
  1 AS `school_year_id`,
  1 AS `total_subject`,
  1 AS `passed`,
  1 AS `failed`,
  1 AS `incomplete`,
  1 AS `no_credit`,
  1 AS `no_grade`,
  1 AS `pass_rate_computed`,
  1 AS `pass_rate_stored`,
  1 AS `remark_id`,
  1 AS `archived_at` */;
SET character_set_client = @saved_cs_client;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `modality` (
  `name` varchar(20) NOT NULL,
  `sort_order` int(11) NOT NULL DEFAULT 0,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `is_locked` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`name`),
  KEY `idx_modality_order` (`is_active`,`sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `pdo_setting` (
  `setting_key` varchar(60) NOT NULL,
  `setting_value` varchar(60) NOT NULL,
  `description` varchar(255) NOT NULL,
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`setting_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `ph_address` (
  `address_id` int(11) NOT NULL AUTO_INCREMENT,
  `psgc_code` varchar(12) NOT NULL,
  `parent_code` varchar(12) DEFAULT NULL,
  `level` enum('region','province','city','municipality','submunicipality','district','barangay') NOT NULL,
  `name` varchar(150) NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`address_id`),
  UNIQUE KEY `uq_ph_address_psgc` (`psgc_code`),
  KEY `idx_ph_address_children` (`parent_code`,`is_active`,`name`),
  KEY `idx_ph_address_level` (`level`,`is_active`,`name`),
  KEY `idx_ph_address_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `ph_address_zip` (
  `zip_id` int(11) NOT NULL AUTO_INCREMENT,
  `psgc_code` varchar(12) NOT NULL COMMENT 'The city, municipality or Manila district the ZIP belongs to',
  `zip_code` char(4) NOT NULL,
  `area` varchar(120) NOT NULL DEFAULT '' COMMENT 'The postal area inside the place when it has several ZIPs; blank = the whole place',
  `source` varchar(20) NOT NULL COMMENT 'phlpost, techpilipinas or zipcodes-ph: which list the row came from',
  PRIMARY KEY (`zip_id`),
  UNIQUE KEY `uq_ph_address_zip` (`psgc_code`,`zip_code`,`area`),
  KEY `idx_ph_address_zip_code` (`zip_code`),
  CONSTRAINT `fk_ph_address_zip_place` FOREIGN KEY (`psgc_code`) REFERENCES `ph_address` (`psgc_code`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `remarks` (
  `remark_id` int(11) NOT NULL AUTO_INCREMENT,
  `remark_name` varchar(100) NOT NULL,
  `description` text DEFAULT NULL,
  `risk_level` varchar(50) NOT NULL,
  `applies_to` varchar(20) NOT NULL DEFAULT 'any' COMMENT 'any | grades | attendance -- which rule engine may assign this remark',
  `status` int(11) DEFAULT 1,
  `archived_at` datetime DEFAULT NULL,
  PRIMARY KEY (`remark_id`),
  KEY `idx_remarks_status` (`status`),
  CONSTRAINT `fk_remarks_status` FOREIGN KEY (`status`) REFERENCES `status` (`status_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `retention_case` (
  `case_id` int(11) NOT NULL AUTO_INCREMENT,
  `student_id` int(11) NOT NULL,
  `department_id` int(11) DEFAULT NULL,
  `semester_id` int(11) NOT NULL,
  `school_year_id` int(11) NOT NULL,
  `period` tinyint(3) unsigned DEFAULT NULL COMMENT 'Retention period this evaluation belongs to: 1, 2 or 3. NULL = the whole semester.',
  `period_key` tinyint(3) unsigned GENERATED ALWAYS AS (coalesce(`period`,0)) STORED COMMENT 'period with NULL folded to 0, so the unique key can compare whole-semester rows. Never read directly.',
  `grade_record_id` int(11) DEFAULT NULL,
  `survey_submission_id` int(11) DEFAULT NULL,
  `academic_risk_level` varchar(20) NOT NULL DEFAULT 'low',
  `survey_risk_level` varchar(20) NOT NULL DEFAULT 'low',
  `combined_risk_level` varchar(20) NOT NULL DEFAULT 'low',
  `evaluation_score` decimal(6,2) NOT NULL DEFAULT 0.00,
  `evaluation_reason` text DEFAULT NULL,
  `validation_status` varchar(20) NOT NULL DEFAULT 'pending',
  `intervention_status` varchar(20) NOT NULL DEFAULT 'unassigned',
  `assigned_to_user_id` int(11) DEFAULT NULL,
  `assigned_by_user_id` int(11) DEFAULT NULL,
  `follow_up_date` date DEFAULT NULL,
  `outcome_summary` text DEFAULT NULL,
  `evaluated_by_user_id` int(11) DEFAULT NULL,
  `evaluated_at` timestamp NULL DEFAULT NULL,
  `validated_by_user_id` int(11) DEFAULT NULL,
  `validated_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `risk_model_id` int(11) DEFAULT NULL,
  PRIMARY KEY (`case_id`),
  UNIQUE KEY `uq_retention_case_student_term_period` (`student_id`,`semester_id`,`school_year_id`,`period_key`),
  KEY `idx_retention_case_department` (`department_id`),
  KEY `idx_retention_case_risk` (`combined_risk_level`),
  KEY `idx_retention_case_validation` (`validation_status`),
  KEY `idx_retention_case_intervention` (`intervention_status`),
  KEY `idx_retention_case_assigned_to` (`assigned_to_user_id`),
  KEY `retention_case_ibfk_semester` (`semester_id`),
  KEY `retention_case_ibfk_school_year` (`school_year_id`),
  KEY `retention_case_ibfk_grade` (`grade_record_id`),
  KEY `retention_case_ibfk_submission` (`survey_submission_id`),
  KEY `retention_case_ibfk_assigned_by` (`assigned_by_user_id`),
  KEY `retention_case_ibfk_evaluated_by` (`evaluated_by_user_id`),
  KEY `retention_case_ibfk_validated_by` (`validated_by_user_id`),
  KEY `idx_retention_case_risk_model` (`risk_model_id`),
  KEY `idx_retention_case_period` (`period_key`,`combined_risk_level`),
  CONSTRAINT `fk_rc_assigned_by` FOREIGN KEY (`assigned_by_user_id`) REFERENCES `user` (`user_id`) ON DELETE SET NULL,
  CONSTRAINT `fk_rc_assigned_to` FOREIGN KEY (`assigned_to_user_id`) REFERENCES `user` (`user_id`) ON DELETE SET NULL,
  CONSTRAINT `fk_rc_department` FOREIGN KEY (`department_id`) REFERENCES `department` (`department_id`) ON DELETE SET NULL,
  CONSTRAINT `fk_rc_evaluated_by` FOREIGN KEY (`evaluated_by_user_id`) REFERENCES `user` (`user_id`) ON DELETE SET NULL,
  CONSTRAINT `fk_rc_grade` FOREIGN KEY (`grade_record_id`) REFERENCES `grades` (`grades_id`) ON DELETE SET NULL,
  CONSTRAINT `fk_rc_school_year` FOREIGN KEY (`school_year_id`) REFERENCES `school_year` (`school_year_id`),
  CONSTRAINT `fk_rc_semester` FOREIGN KEY (`semester_id`) REFERENCES `semester` (`semester_id`),
  CONSTRAINT `fk_rc_student` FOREIGN KEY (`student_id`) REFERENCES `student` (`student_id`),
  CONSTRAINT `fk_rc_submission` FOREIGN KEY (`survey_submission_id`) REFERENCES `survey_submission` (`submission_id`) ON DELETE SET NULL,
  CONSTRAINT `fk_rc_validated_by` FOREIGN KEY (`validated_by_user_id`) REFERENCES `user` (`user_id`) ON DELETE SET NULL,
  CONSTRAINT `fk_retention_case_risk_model` FOREIGN KEY (`risk_model_id`) REFERENCES `risk_model` (`model_id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `retention_case_indicator_hit` (
  `hit_id` int(11) NOT NULL AUTO_INCREMENT,
  `case_id` int(11) NOT NULL,
  `indicator_id` int(11) DEFAULT NULL,
  `category_id` int(11) NOT NULL,
  `source` varchar(20) NOT NULL,
  `field_key` varchar(64) NOT NULL,
  `observed_value` varchar(255) DEFAULT NULL,
  `points_awarded` decimal(5,2) NOT NULL DEFAULT 0.00,
  `reason` varchar(255) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`hit_id`),
  KEY `idx_hit_case` (`case_id`),
  KEY `idx_hit_category` (`category_id`),
  KEY `idx_hit_indicator` (`indicator_id`),
  CONSTRAINT `fk_hit_case` FOREIGN KEY (`case_id`) REFERENCES `retention_case` (`case_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_hit_category` FOREIGN KEY (`category_id`) REFERENCES `risk_category` (`category_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_hit_indicator` FOREIGN KEY (`indicator_id`) REFERENCES `risk_indicator` (`indicator_id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `retention_case_note` (
  `note_id` int(11) NOT NULL AUTO_INCREMENT,
  `case_id` int(11) NOT NULL,
  `note_type` varchar(30) NOT NULL DEFAULT 'intervention',
  `note_body` text NOT NULL,
  `created_by_user_id` int(11) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`note_id`),
  KEY `idx_retention_case_note_case` (`case_id`),
  KEY `retention_case_note_ibfk_user` (`created_by_user_id`),
  CONSTRAINT `retention_case_note_ibfk_case` FOREIGN KEY (`case_id`) REFERENCES `retention_case` (`case_id`) ON DELETE CASCADE,
  CONSTRAINT `retention_case_note_ibfk_user` FOREIGN KEY (`created_by_user_id`) REFERENCES `user` (`user_id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `retention_status_label` (
  `label_id` int(11) NOT NULL AUTO_INCREMENT,
  `status_group` varchar(30) NOT NULL,
  `status_code` varchar(30) NOT NULL,
  `label` varchar(60) NOT NULL,
  `sort_order` int(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (`label_id`),
  UNIQUE KEY `uq_retention_status_label` (`status_group`,`status_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `risk_category` (
  `category_id` int(11) NOT NULL AUTO_INCREMENT,
  `category_code` varchar(30) NOT NULL,
  `category_name` varchar(100) NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `sort_order` int(11) NOT NULL DEFAULT 0,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `archived_at` datetime DEFAULT NULL,
  PRIMARY KEY (`category_id`),
  UNIQUE KEY `uq_risk_category_code` (`category_code`),
  KEY `idx_risk_category_active` (`is_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `risk_indicator` (
  `indicator_id` int(11) NOT NULL AUTO_INCREMENT,
  `model_id` int(11) NOT NULL,
  `category_id` int(11) NOT NULL,
  `label` varchar(120) NOT NULL,
  `source` varchar(20) NOT NULL,
  `field_key` varchar(64) NOT NULL,
  `operator` varchar(12) NOT NULL DEFAULT 'gte',
  `value_min` decimal(12,2) DEFAULT NULL,
  `value_max` decimal(12,2) DEFAULT NULL,
  `value_text` varchar(255) DEFAULT NULL,
  `points` decimal(5,2) NOT NULL DEFAULT 1.00,
  `reason_template` varchar(255) DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `sort_order` int(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (`indicator_id`),
  KEY `idx_risk_indicator_model` (`model_id`,`is_active`),
  KEY `idx_risk_indicator_category` (`category_id`),
  KEY `idx_risk_indicator_source` (`source`,`field_key`),
  CONSTRAINT `fk_risk_indicator_category` FOREIGN KEY (`category_id`) REFERENCES `risk_category` (`category_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_risk_indicator_model` FOREIGN KEY (`model_id`) REFERENCES `risk_model` (`model_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `risk_keyword` (
  `keyword_id` int(11) NOT NULL AUTO_INCREMENT,
  `category_id` int(11) NOT NULL,
  `keyword` varchar(64) NOT NULL,
  `points` decimal(5,2) NOT NULL DEFAULT 1.00,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (`keyword_id`),
  UNIQUE KEY `uq_risk_keyword` (`category_id`,`keyword`),
  CONSTRAINT `fk_risk_keyword_category` FOREIGN KEY (`category_id`) REFERENCES `risk_category` (`category_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `risk_model` (
  `model_id` int(11) NOT NULL AUTO_INCREMENT,
  `model_name` varchar(120) NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `school_year_id` int(11) DEFAULT NULL,
  `semester_id` int(11) DEFAULT NULL,
  `moderate_threshold` decimal(6,2) NOT NULL DEFAULT 3.00,
  `high_threshold` decimal(6,2) NOT NULL DEFAULT 6.00,
  `is_active` tinyint(1) NOT NULL DEFAULT 0,
  `created_by_user_id` int(11) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`model_id`),
  UNIQUE KEY `uq_risk_model_name` (`model_name`),
  KEY `idx_risk_model_active` (`is_active`),
  KEY `fk_risk_model_school_year` (`school_year_id`),
  KEY `fk_risk_model_semester` (`semester_id`),
  KEY `fk_risk_model_created_by` (`created_by_user_id`),
  CONSTRAINT `fk_risk_model_created_by` FOREIGN KEY (`created_by_user_id`) REFERENCES `user` (`user_id`) ON DELETE SET NULL,
  CONSTRAINT `fk_risk_model_school_year` FOREIGN KEY (`school_year_id`) REFERENCES `school_year` (`school_year_id`) ON DELETE SET NULL,
  CONSTRAINT `fk_risk_model_semester` FOREIGN KEY (`semester_id`) REFERENCES `semester` (`semester_id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `role` (
  `role_id` int(11) NOT NULL AUTO_INCREMENT,
  `role_name` varchar(100) NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `archived_at` datetime DEFAULT NULL,
  PRIMARY KEY (`role_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `scholarship_grant` (
  `name` varchar(60) NOT NULL,
  `sort_order` int(11) NOT NULL DEFAULT 0,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `is_locked` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`name`),
  KEY `idx_scholarship_grant_order` (`is_active`,`sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `school_year` (
  `school_year_id` int(11) NOT NULL AUTO_INCREMENT,
  `schoolyear_name` varchar(50) DEFAULT NULL,
  `schoolyear_status` int(11) DEFAULT NULL,
  `is_current` tinyint(1) NOT NULL DEFAULT 0 COMMENT 'The year the portal treats as now. Exactly one row may hold 1.',
  `current_marker` tinyint(1) GENERATED ALWAYS AS (case when `is_current` = 1 then 1 else NULL end) STORED COMMENT 'NULL unless this row is current, so the unique key below allows only one',
  PRIMARY KEY (`school_year_id`),
  UNIQUE KEY `uq_school_year_current` (`current_marker`),
  UNIQUE KEY `uq_school_year_name` (`schoolyear_name`),
  KEY `schoolyear_status` (`schoolyear_status`),
  CONSTRAINT `fk_school_year_status` FOREIGN KEY (`schoolyear_status`) REFERENCES `status` (`status_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `semester` (
  `semester_id` int(11) NOT NULL AUTO_INCREMENT,
  `semester_name` varchar(50) DEFAULT NULL,
  `semester_status` int(11) DEFAULT NULL,
  PRIMARY KEY (`semester_id`),
  UNIQUE KEY `uq_semester_name` (`semester_name`),
  KEY `semester_status` (`semester_status`),
  CONSTRAINT `fk_semester_status` FOREIGN KEY (`semester_status`) REFERENCES `status` (`status_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `ssp_assignment` (
  `assignment_id` int(11) NOT NULL AUTO_INCREMENT,
  `student_id` int(11) NOT NULL,
  `caller_user_id` int(11) NOT NULL,
  `assigned_by_user_id` int(11) NOT NULL,
  `notes` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`assignment_id`),
  UNIQUE KEY `ssp_assignment_student_caller_unique` (`student_id`,`caller_user_id`),
  KEY `ssp_assignment_caller_idx` (`caller_user_id`),
  KEY `ssp_assignment_assigned_by_idx` (`assigned_by_user_id`),
  KEY `ssp_assignment_student_idx` (`student_id`),
  CONSTRAINT `fk_ssp_assigner` FOREIGN KEY (`assigned_by_user_id`) REFERENCES `user` (`user_id`),
  CONSTRAINT `fk_ssp_caller` FOREIGN KEY (`caller_user_id`) REFERENCES `user` (`user_id`),
  CONSTRAINT `fk_ssp_student` FOREIGN KEY (`student_id`) REFERENCES `student` (`student_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `status` (
  `status_id` int(11) NOT NULL AUTO_INCREMENT,
  `status_name` varchar(100) NOT NULL,
  `status_type` varchar(50) NOT NULL,
  `range_min` decimal(12,2) DEFAULT NULL COMMENT 'Finance bands only: exclusive lower bound, NULL means unbounded',
  `range_max` decimal(12,2) DEFAULT NULL COMMENT 'Finance bands only: inclusive upper bound, NULL means unbounded',
  `archived_at` datetime DEFAULT NULL,
  `sort_order` int(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (`status_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `student` (
  `student_id` int(11) NOT NULL AUTO_INCREMENT,
  `student_number` varchar(50) NOT NULL,
  `star e-profile` enum('STAR','Non-STAR') NOT NULL DEFAULT 'Non-STAR',
  `first_name` varchar(100) DEFAULT NULL,
  `last_name` varchar(100) DEFAULT NULL,
  `middle_name` varchar(100) DEFAULT NULL,
  `extension_name` varchar(20) DEFAULT NULL,
  `gender` varchar(20) DEFAULT NULL COMMENT 'Blank means not recorded. Values: gender.name',
  `email_address` varchar(150) DEFAULT NULL,
  `modality` varchar(20) NOT NULL DEFAULT 'Flex' COMMENT 'Values: modality.name',
  `mobile_number` varchar(20) DEFAULT NULL,
  `mother_number` varchar(20) DEFAULT NULL,
  `father_number` varchar(20) DEFAULT NULL,
  `home_address` text DEFAULT NULL,
  `facebook_name` varchar(100) DEFAULT NULL,
  `course_id` int(11) DEFAULT NULL,
  `user_id` int(11) DEFAULT NULL,
  `schoolyear_id` int(11) DEFAULT NULL,
  `batch_id` int(11) DEFAULT NULL,
  `year_level` int(11) DEFAULT NULL,
  `section` varchar(50) DEFAULT NULL,
  `is_irregular` tinyint(1) NOT NULL DEFAULT 0 COMMENT '1 = carrying back subjects; set by the year-end migration',
  `coaching_unit` int(11) DEFAULT NULL,
  `final_scholarship_grant` varchar(60) DEFAULT NULL COMMENT 'Blank means not recorded. Values: scholarship_grant.name',
  `archived_at` datetime DEFAULT NULL,
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`student_id`),
  UNIQUE KEY `uq_student_number` (`student_number`),
  KEY `course_id` (`course_id`),
  KEY `user_id` (`user_id`),
  KEY `schoolyear_id` (`schoolyear_id`),
  KEY `batch_id` (`batch_id`),
  KEY `coaching_unit` (`coaching_unit`),
  KEY `idx_student_student_type` (`star e-profile`),
  KEY `idx_student_year_level` (`year_level`),
  KEY `idx_student_archived_at` (`archived_at`),
  KEY `idx_student_updated_at` (`updated_at`),
  KEY `fk_student_scholarship_grant` (`final_scholarship_grant`),
  KEY `fk_student_gender` (`gender`),
  KEY `fk_student_modality` (`modality`),
  CONSTRAINT `fk_student_course` FOREIGN KEY (`course_id`) REFERENCES `course` (`course_id`),
  CONSTRAINT `fk_student_gender` FOREIGN KEY (`gender`) REFERENCES `gender` (`name`) ON UPDATE CASCADE,
  CONSTRAINT `fk_student_modality` FOREIGN KEY (`modality`) REFERENCES `modality` (`name`) ON UPDATE CASCADE,
  CONSTRAINT `fk_student_scholarship_grant` FOREIGN KEY (`final_scholarship_grant`) REFERENCES `scholarship_grant` (`name`) ON UPDATE CASCADE,
  CONSTRAINT `fk_student_schoolyear` FOREIGN KEY (`schoolyear_id`) REFERENCES `school_year` (`school_year_id`),
  CONSTRAINT `fk_student_user` FOREIGN KEY (`user_id`) REFERENCES `user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `student_contact_attempt` (
  `attempt_id` int(11) NOT NULL AUTO_INCREMENT,
  `contact_case_id` int(11) NOT NULL,
  `student_id` int(11) NOT NULL,
  `attempted_by_user_id` int(11) DEFAULT NULL,
  `attempted_by_role_id` int(11) DEFAULT NULL,
  `contact_method` varchar(40) NOT NULL,
  `other_method_label` varchar(120) DEFAULT NULL,
  `contact_status` varchar(40) NOT NULL,
  `reason_id` int(11) DEFAULT NULL,
  `other_reason_label` varchar(160) DEFAULT NULL,
  `recovery_plan_id` int(11) DEFAULT NULL,
  `intervention_status` varchar(40) DEFAULT NULL COMMENT 'Coach: recovered/not_recovered/referred_to_csdl/cbr_follow_up/undecided_follow_up. CSDL: recovered/not_recovered/unreachable.',
  `contacted_at` datetime NOT NULL,
  `school_year_id` int(11) DEFAULT NULL,
  `semester_id` int(11) DEFAULT NULL,
  `period` tinyint(4) DEFAULT NULL,
  `follow_up_due_at` datetime DEFAULT NULL,
  `notes` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`attempt_id`),
  KEY `idx_student_contact_attempt_case` (`contact_case_id`),
  KEY `idx_student_contact_attempt_student` (`student_id`),
  KEY `idx_student_contact_attempt_status` (`contact_status`),
  KEY `idx_student_contact_attempt_due` (`follow_up_due_at`),
  KEY `student_contact_attempt_ibfk_user` (`attempted_by_user_id`),
  KEY `idx_sca_role` (`attempted_by_role_id`),
  KEY `fk_sca_case_student` (`contact_case_id`,`student_id`),
  KEY `idx_contact_attempt_reason` (`reason_id`),
  KEY `idx_contact_attempt_plan` (`recovery_plan_id`),
  KEY `idx_contact_attempt_intervention` (`intervention_status`),
  KEY `idx_attempt_term` (`school_year_id`,`semester_id`,`period`),
  KEY `idx_attempt_student_term` (`student_id`,`school_year_id`,`semester_id`,`period`),
  KEY `fk_contact_attempt_channel` (`contact_method`),
  CONSTRAINT `fk_contact_attempt_channel` FOREIGN KEY (`contact_method`) REFERENCES `contact_channel` (`channel_key`),
  CONSTRAINT `fk_contact_attempt_plan` FOREIGN KEY (`recovery_plan_id`) REFERENCES `contact_recovery_plan` (`plan_id`),
  CONSTRAINT `fk_contact_attempt_reason` FOREIGN KEY (`reason_id`) REFERENCES `contact_reason` (`reason_id`),
  CONSTRAINT `fk_sca_case_student` FOREIGN KEY (`contact_case_id`, `student_id`) REFERENCES `student_contact_case` (`case_id`, `student_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_sca_role` FOREIGN KEY (`attempted_by_role_id`) REFERENCES `role` (`role_id`) ON DELETE SET NULL,
  CONSTRAINT `fk_sca_user` FOREIGN KEY (`attempted_by_user_id`) REFERENCES `user` (`user_id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `student_contact_case` (
  `case_id` int(11) NOT NULL AUTO_INCREMENT,
  `student_id` int(11) NOT NULL,
  `department_id` int(11) DEFAULT NULL,
  `workflow_status` varchar(40) NOT NULL DEFAULT 'pending_contact',
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `latest_attempt_id` int(11) DEFAULT NULL,
  `latest_contact_status` varchar(40) DEFAULT NULL,
  `latest_contacted_at` datetime DEFAULT NULL,
  `next_follow_up_at` datetime DEFAULT NULL,
  `escalated_at` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`case_id`),
  UNIQUE KEY `uq_student_contact_case_student` (`student_id`),
  UNIQUE KEY `uq_scc_case_student` (`case_id`,`student_id`),
  KEY `idx_student_contact_case_department` (`department_id`),
  KEY `idx_student_contact_case_active` (`is_active`),
  KEY `idx_student_contact_case_status` (`workflow_status`),
  KEY `idx_student_contact_case_followup` (`next_follow_up_at`),
  CONSTRAINT `fk_scc_department` FOREIGN KEY (`department_id`) REFERENCES `department` (`department_id`) ON DELETE SET NULL,
  CONSTRAINT `fk_scc_student` FOREIGN KEY (`student_id`) REFERENCES `student` (`student_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `student_home_visit` (
  `home_visit_id` int(11) NOT NULL AUTO_INCREMENT,
  `contact_case_id` int(11) NOT NULL,
  `student_id` int(11) NOT NULL,
  `source_attempt_id` int(11) DEFAULT NULL,
  `assigned_staff_user_id` int(11) DEFAULT NULL,
  `created_by_user_id` int(11) DEFAULT NULL,
  `escalation_reason` varchar(255) DEFAULT NULL,
  `queue_status` varchar(40) NOT NULL DEFAULT 'queued',
  `scheduled_visit_at` datetime DEFAULT NULL,
  `visit_remarks` text DEFAULT NULL,
  `completed_at` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`home_visit_id`),
  UNIQUE KEY `uq_student_home_visit_case` (`contact_case_id`),
  KEY `idx_student_home_visit_student` (`student_id`),
  KEY `idx_student_home_visit_status` (`queue_status`),
  KEY `idx_student_home_visit_assigned` (`assigned_staff_user_id`),
  KEY `student_home_visit_ibfk_attempt` (`source_attempt_id`),
  KEY `student_home_visit_ibfk_created_by` (`created_by_user_id`),
  KEY `fk_shv_case_student` (`contact_case_id`,`student_id`),
  CONSTRAINT `fk_shv_assigned` FOREIGN KEY (`assigned_staff_user_id`) REFERENCES `user` (`user_id`) ON DELETE SET NULL,
  CONSTRAINT `fk_shv_attempt` FOREIGN KEY (`source_attempt_id`) REFERENCES `student_contact_attempt` (`attempt_id`) ON DELETE SET NULL,
  CONSTRAINT `fk_shv_case_student` FOREIGN KEY (`contact_case_id`, `student_id`) REFERENCES `student_contact_case` (`case_id`, `student_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_shv_created_by` FOREIGN KEY (`created_by_user_id`) REFERENCES `user` (`user_id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `student_term_snapshot` (
  `snapshot_id` int(11) NOT NULL AUTO_INCREMENT,
  `student_id` int(11) NOT NULL,
  `school_year_id` int(11) NOT NULL,
  `semester_id` int(11) NOT NULL,
  `year_level` int(11) DEFAULT NULL,
  `section` varchar(50) DEFAULT NULL,
  `is_irregular` tinyint(1) DEFAULT NULL,
  `course_id` int(11) DEFAULT NULL,
  `star e-profile` enum('STAR','Non-STAR') DEFAULT NULL,
  `modality` varchar(20) DEFAULT NULL,
  `coaching_unit` int(11) DEFAULT NULL,
  `final_scholarship_grant` varchar(60) DEFAULT NULL,
  `recorded_at` datetime NOT NULL DEFAULT current_timestamp(),
  `recorded_by_user_id` int(11) DEFAULT NULL,
  PRIMARY KEY (`snapshot_id`),
  UNIQUE KEY `uq_student_term_snapshot` (`student_id`,`school_year_id`,`semester_id`),
  KEY `idx_student_term_snapshot_term` (`school_year_id`,`semester_id`),
  KEY `idx_student_term_snapshot_course` (`course_id`),
  KEY `fk_student_term_snapshot_semester` (`semester_id`),
  KEY `fk_student_term_snapshot_user` (`recorded_by_user_id`),
  KEY `fk_snapshot_scholarship_grant` (`final_scholarship_grant`),
  KEY `fk_snapshot_modality` (`modality`),
  CONSTRAINT `fk_snapshot_modality` FOREIGN KEY (`modality`) REFERENCES `modality` (`name`) ON UPDATE CASCADE,
  CONSTRAINT `fk_snapshot_scholarship_grant` FOREIGN KEY (`final_scholarship_grant`) REFERENCES `scholarship_grant` (`name`) ON UPDATE CASCADE,
  CONSTRAINT `fk_student_term_snapshot_course` FOREIGN KEY (`course_id`) REFERENCES `course` (`course_id`),
  CONSTRAINT `fk_student_term_snapshot_school_year` FOREIGN KEY (`school_year_id`) REFERENCES `school_year` (`school_year_id`),
  CONSTRAINT `fk_student_term_snapshot_semester` FOREIGN KEY (`semester_id`) REFERENCES `semester` (`semester_id`),
  CONSTRAINT `fk_student_term_snapshot_student` FOREIGN KEY (`student_id`) REFERENCES `student` (`student_id`),
  CONSTRAINT `fk_student_term_snapshot_user` FOREIGN KEY (`recorded_by_user_id`) REFERENCES `user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `student_year_migration` (
  `year_migration_id` int(11) NOT NULL AUTO_INCREMENT,
  `student_id` int(11) NOT NULL,
  `school_year_id` int(11) NOT NULL COMMENT 'The school year that was evaluated',
  `override_classification` varchar(32) DEFAULT NULL COMMENT 'An evaluator''s decision; wins over the rules',
  `override_reason` varchar(255) DEFAULT NULL,
  `override_by_user_id` int(11) DEFAULT NULL,
  `override_at` datetime DEFAULT NULL,
  `computed_classification` varchar(32) DEFAULT NULL COMMENT 'What the rules said when it was applied',
  `classification` varchar(32) DEFAULT NULL COMMENT 'What was applied: the override if any, else the computed one',
  `reasons` text DEFAULT NULL COMMENT 'JSON array of the sentences behind the classification',
  `subjects_total` int(11) DEFAULT NULL,
  `subjects_failed` int(11) DEFAULT NULL,
  `balance` decimal(10,2) DEFAULT NULL,
  `year_level_from` int(11) DEFAULT NULL,
  `year_level_to` int(11) DEFAULT NULL,
  `section_from` varchar(50) DEFAULT NULL,
  `section_to` varchar(50) DEFAULT NULL,
  `irregular_from` tinyint(1) DEFAULT NULL,
  `irregular_to` tinyint(1) DEFAULT NULL,
  `applied_at` datetime DEFAULT NULL COMMENT 'Set = the year level was moved. NULL = an override waiting, or reverted.',
  `applied_by_user_id` int(11) DEFAULT NULL,
  PRIMARY KEY (`year_migration_id`),
  UNIQUE KEY `uq_year_migration_student_year` (`student_id`,`school_year_id`),
  KEY `idx_year_migration_year` (`school_year_id`),
  CONSTRAINT `fk_year_migration_school_year` FOREIGN KEY (`school_year_id`) REFERENCES `school_year` (`school_year_id`),
  CONSTRAINT `fk_year_migration_student` FOREIGN KEY (`student_id`) REFERENCES `student` (`student_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `survey` (
  `survey_id` int(11) NOT NULL AUTO_INCREMENT,
  `semester_id` int(11) DEFAULT NULL,
  `period` tinyint(3) unsigned DEFAULT NULL COMMENT 'Retention period this survey is run in: 1, 2 or 3. NULL = covers the whole semester.',
  `date` date DEFAULT NULL,
  `survey_year` smallint(6) GENERATED ALWAYS AS (year(`date`)) STORED COMMENT 'Year of `date`, for uq_survey_title_term. Computed; never written.',
  `survey_title` varchar(255) DEFAULT NULL,
  `status` int(11) DEFAULT NULL,
  PRIMARY KEY (`survey_id`),
  UNIQUE KEY `uq_survey_title_term` (`survey_title`,`semester_id`,`survey_year`),
  KEY `semester_id` (`semester_id`),
  KEY `status` (`status`),
  KEY `idx_survey_semester_period` (`semester_id`,`period`),
  CONSTRAINT `fk_survey_semester` FOREIGN KEY (`semester_id`) REFERENCES `semester` (`semester_id`),
  CONSTRAINT `fk_survey_status` FOREIGN KEY (`status`) REFERENCES `status` (`status_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `survey_answer` (
  `answer_id` int(11) NOT NULL AUTO_INCREMENT,
  `question_id` int(11) DEFAULT NULL,
  `option_id` int(11) DEFAULT NULL,
  `answer` text DEFAULT NULL,
  `submission_id` int(11) DEFAULT NULL,
  PRIMARY KEY (`answer_id`),
  UNIQUE KEY `uq_submission_question_option` (`submission_id`,`question_id`,`option_id`),
  KEY `fk_answer_option` (`option_id`),
  KEY `idx_submission_id` (`submission_id`),
  KEY `idx_question_id` (`question_id`),
  CONSTRAINT `fk_sa_option` FOREIGN KEY (`option_id`) REFERENCES `survey_question_option` (`option_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_sa_question` FOREIGN KEY (`question_id`) REFERENCES `survey_question` (`question_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_sa_submission` FOREIGN KEY (`submission_id`) REFERENCES `survey_submission` (`submission_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `survey_question` (
  `question_id` int(11) NOT NULL AUTO_INCREMENT,
  `survey_id` int(11) DEFAULT NULL,
  `question_text` text NOT NULL,
  `question_type` enum('text','radio','checkbox','rating') NOT NULL,
  `answer_format` varchar(20) NOT NULL DEFAULT 'any' COMMENT 'any | letters | number | phone - see lib/survey_answer_format.php',
  `answer_max_length` int(11) DEFAULT NULL COMMENT 'text answers only: caps length below the answer_format ceiling; NULL = use the format default',
  `is_required` tinyint(1) NOT NULL DEFAULT 0,
  `sort_order` int(11) DEFAULT NULL,
  `risk_category_id` int(11) DEFAULT NULL,
  `risk_weight` decimal(4,2) NOT NULL DEFAULT 1.00,
  `is_scored` tinyint(1) NOT NULL DEFAULT 0,
  `rating_min` int(11) NOT NULL DEFAULT 1,
  `rating_max` int(11) NOT NULL DEFAULT 5,
  `rating_risk_is_low` tinyint(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (`question_id`),
  UNIQUE KEY `uq_survey_question_text` (`survey_id`,`question_text`(300)),
  KEY `survey_id` (`survey_id`),
  KEY `idx_survey_question_risk_category` (`risk_category_id`),
  CONSTRAINT `fk_sq_survey` FOREIGN KEY (`survey_id`) REFERENCES `survey` (`survey_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_survey_question_risk_category` FOREIGN KEY (`risk_category_id`) REFERENCES `risk_category` (`category_id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `survey_question_condition` (
  `condition_id` int(11) NOT NULL AUTO_INCREMENT,
  `question_id` int(11) NOT NULL COMMENT 'the question being shown or hidden',
  `option_id` int(11) NOT NULL COMMENT 'the answer that reveals it',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`condition_id`),
  UNIQUE KEY `uq_sqc_question_option` (`question_id`,`option_id`),
  KEY `idx_sqc_question` (`question_id`),
  KEY `idx_sqc_option` (`option_id`),
  CONSTRAINT `fk_sqc_option` FOREIGN KEY (`option_id`) REFERENCES `survey_question_option` (`option_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_sqc_question` FOREIGN KEY (`question_id`) REFERENCES `survey_question` (`question_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `survey_question_option` (
  `option_id` int(11) NOT NULL AUTO_INCREMENT,
  `question_id` int(11) NOT NULL,
  `option_text` varchar(255) NOT NULL,
  `risk_points` decimal(4,2) NOT NULL DEFAULT 0.00,
  `enrollment_status_id` int(11) DEFAULT NULL,
  PRIMARY KEY (`option_id`),
  UNIQUE KEY `uq_survey_option_text` (`question_id`,`option_text`),
  KEY `question_id` (`question_id`),
  KEY `idx_sqo_enrollment_status` (`enrollment_status_id`),
  CONSTRAINT `fk_sqo_enrollment_status` FOREIGN KEY (`enrollment_status_id`) REFERENCES `status` (`status_id`) ON DELETE SET NULL,
  CONSTRAINT `fk_sqo_question` FOREIGN KEY (`question_id`) REFERENCES `survey_question` (`question_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `survey_submission` (
  `submission_id` int(11) NOT NULL AUTO_INCREMENT,
  `survey_id` int(11) NOT NULL,
  `student_id` int(11) NOT NULL,
  `submitted_at` datetime DEFAULT current_timestamp(),
  `archived_at` datetime DEFAULT NULL COMMENT 'Set = archived: kept with its answers, counted nowhere',
  `archived_by_user_id` int(11) DEFAULT NULL,
  `archive_slot` int(11) NOT NULL DEFAULT 0 COMMENT '0 while live; the submission_id once archived',
  PRIMARY KEY (`submission_id`),
  UNIQUE KEY `uq_survey_submission_live` (`survey_id`,`student_id`,`archive_slot`),
  KEY `student_id` (`student_id`),
  CONSTRAINT `fk_ss_student` FOREIGN KEY (`student_id`) REFERENCES `student` (`student_id`),
  CONSTRAINT `fk_ss_survey` FOREIGN KEY (`survey_id`) REFERENCES `survey` (`survey_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `system_backup_config` (
  `config_id` int(11) NOT NULL AUTO_INCREMENT,
  `is_enabled` tinyint(1) NOT NULL DEFAULT 1,
  `schedule_type` varchar(20) NOT NULL DEFAULT 'daily',
  `backup_hour` tinyint(3) unsigned NOT NULL DEFAULT 2,
  `backup_minute` tinyint(3) unsigned NOT NULL DEFAULT 0,
  `weekly_day` tinyint(3) unsigned DEFAULT 1,
  `monthly_day` tinyint(3) unsigned DEFAULT 1,
  `custom_at` datetime DEFAULT NULL,
  `storage_path` varchar(500) DEFAULT NULL,
  `updated_by_user_id` int(11) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`config_id`),
  KEY `idx_sbc_updated_by` (`updated_by_user_id`),
  CONSTRAINT `fk_sbc_user` FOREIGN KEY (`updated_by_user_id`) REFERENCES `user` (`user_id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `system_backup_history` (
  `history_id` int(11) NOT NULL AUTO_INCREMENT,
  `event_type` varchar(20) NOT NULL DEFAULT 'backup',
  `trigger_type` varchar(20) NOT NULL DEFAULT 'manual',
  `status` varchar(20) NOT NULL DEFAULT 'running',
  `run_key` varchar(191) DEFAULT NULL,
  `scheduled_for` datetime DEFAULT NULL,
  `file_name` varchar(255) DEFAULT NULL,
  `file_path` text DEFAULT NULL,
  `file_size` bigint(20) DEFAULT NULL,
  `storage_path` varchar(500) DEFAULT NULL,
  `message` text DEFAULT NULL,
  `related_backup_id` int(11) DEFAULT NULL,
  `initiated_by_user_id` int(11) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `completed_at` datetime DEFAULT NULL,
  PRIMARY KEY (`history_id`),
  UNIQUE KEY `uniq_system_backup_run_key` (`run_key`),
  KEY `idx_system_backup_created_at` (`created_at`),
  KEY `idx_system_backup_status` (`status`),
  KEY `idx_system_backup_event_type` (`event_type`),
  KEY `idx_sbh_related` (`related_backup_id`),
  KEY `fk_sbh_user` (`initiated_by_user_id`),
  CONSTRAINT `fk_sbh_related` FOREIGN KEY (`related_backup_id`) REFERENCES `system_backup_history` (`history_id`) ON DELETE SET NULL,
  CONSTRAINT `fk_sbh_user` FOREIGN KEY (`initiated_by_user_id`) REFERENCES `user` (`user_id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `system_notification` (
  `notification_id` int(11) NOT NULL AUTO_INCREMENT,
  `event_key` varchar(100) NOT NULL,
  `level` varchar(20) NOT NULL DEFAULT 'info',
  `title` varchar(255) NOT NULL,
  `message` text NOT NULL,
  `module_key` varchar(100) DEFAULT NULL,
  `entity_type` varchar(100) DEFAULT NULL,
  `entity_id` int(11) DEFAULT NULL,
  `actor_user_id` int(11) DEFAULT NULL,
  `target_view` varchar(100) DEFAULT NULL,
  `target_report` varchar(100) DEFAULT NULL,
  `target_section` varchar(100) DEFAULT NULL,
  `target_overlay` varchar(100) DEFAULT NULL,
  `toast` tinyint(1) NOT NULL DEFAULT 0,
  `metadata` longtext DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`notification_id`),
  KEY `idx_system_notification_created_at` (`created_at`),
  KEY `idx_system_notification_event_key` (`event_key`),
  KEY `idx_system_notification_module_key` (`module_key`),
  KEY `fk_sn_actor` (`actor_user_id`),
  CONSTRAINT `fk_sn_actor` FOREIGN KEY (`actor_user_id`) REFERENCES `user` (`user_id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `system_notification_recipient` (
  `recipient_id` int(11) NOT NULL AUTO_INCREMENT,
  `notification_id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `is_read` tinyint(1) NOT NULL DEFAULT 0,
  `read_at` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`recipient_id`),
  UNIQUE KEY `uniq_system_notification_recipient` (`notification_id`,`user_id`),
  KEY `idx_system_notification_recipient_unread` (`user_id`,`is_read`),
  KEY `idx_system_notification_recipient_created` (`created_at`),
  CONSTRAINT `fk_snr_notification` FOREIGN KEY (`notification_id`) REFERENCES `system_notification` (`notification_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_snr_user` FOREIGN KEY (`user_id`) REFERENCES `user` (`user_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `term_closure` (
  `school_year_id` int(11) NOT NULL,
  `semester_id` int(11) NOT NULL,
  `closed_at` datetime DEFAULT NULL COMMENT 'Set = closed: its records are read-only. NULL = reopened.',
  `closed_by_user_id` int(11) DEFAULT NULL,
  `reopened_at` datetime DEFAULT NULL COMMENT 'The last time it was reopened',
  `reopened_by_user_id` int(11) DEFAULT NULL,
  `reopen_reason` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`school_year_id`,`semester_id`),
  KEY `idx_term_closure_semester` (`semester_id`),
  KEY `idx_term_closure_closed_by` (`closed_by_user_id`),
  KEY `idx_term_closure_reopened_by` (`reopened_by_user_id`),
  CONSTRAINT `fk_term_closure_closed_by` FOREIGN KEY (`closed_by_user_id`) REFERENCES `user` (`user_id`) ON DELETE SET NULL,
  CONSTRAINT `fk_term_closure_reopened_by` FOREIGN KEY (`reopened_by_user_id`) REFERENCES `user` (`user_id`) ON DELETE SET NULL,
  CONSTRAINT `fk_term_closure_school_year` FOREIGN KEY (`school_year_id`) REFERENCES `school_year` (`school_year_id`),
  CONSTRAINT `fk_term_closure_semester` FOREIGN KEY (`semester_id`) REFERENCES `semester` (`semester_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `user` (
  `user_id` int(11) NOT NULL AUTO_INCREMENT,
  `first_name` varchar(100) DEFAULT NULL,
  `last_name` varchar(100) DEFAULT NULL,
  `role` int(11) DEFAULT NULL,
  `department` int(11) DEFAULT NULL,
  `campus_id` int(11) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `status` int(11) DEFAULT NULL,
  `email` varchar(150) DEFAULT NULL,
  `phone_number` varchar(25) DEFAULT NULL,
  `password` varchar(255) DEFAULT NULL,
  `token_version` int(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (`user_id`),
  UNIQUE KEY `uq_user_email` (`email`),
  KEY `role` (`role`),
  KEY `department` (`department`),
  KEY `status` (`status`),
  KEY `idx_user_campus_id` (`campus_id`),
  CONSTRAINT `fk_user_campus` FOREIGN KEY (`campus_id`) REFERENCES `campus` (`campus_id`),
  CONSTRAINT `fk_user_department` FOREIGN KEY (`department`) REFERENCES `department` (`department_id`),
  CONSTRAINT `fk_user_role` FOREIGN KEY (`role`) REFERENCES `role` (`role_id`),
  CONSTRAINT `fk_user_status` FOREIGN KEY (`status`) REFERENCES `status` (`status_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `year_migration_setting` (
  `setting_key` varchar(60) NOT NULL,
  `setting_value` varchar(60) NOT NULL,
  `description` varchar(255) NOT NULL,
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`setting_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50001 DROP VIEW IF EXISTS `grades_with_pass_rate`*/;
/*!50001 SET @saved_cs_client          = @@character_set_client */;
/*!50001 SET @saved_cs_results         = @@character_set_results */;
/*!50001 SET @saved_col_connection     = @@collation_connection */;
/*!50001 SET character_set_client      = utf8mb4 */;
/*!50001 SET character_set_results     = utf8mb4 */;
/*!50001 SET collation_connection      = utf8mb4_general_ci */;
/*!50001 CREATE ALGORITHM=UNDEFINED */
/*!50013 SQL SECURITY INVOKER */
/*!50001 VIEW `grades_with_pass_rate` AS select `g`.`grades_id` AS `grades_id`,`g`.`student_id` AS `student_id`,`g`.`semester_id` AS `semester_id`,`g`.`school_year_id` AS `school_year_id`,`g`.`total_subject` AS `total_subject`,`g`.`passed` AS `passed`,`g`.`failed` AS `failed`,`g`.`incomplete` AS `incomplete`,`g`.`no_credit` AS `no_credit`,`g`.`no_grade` AS `no_grade`,case when `g`.`total_subject` > 0 then round(`g`.`passed` / `g`.`total_subject` * 100,2) else 0.00 end AS `pass_rate_computed`,`g`.`passed_of_subject` AS `pass_rate_stored`,`g`.`remark_id` AS `remark_id`,`g`.`archived_at` AS `archived_at` from `grades` `g` */;
/*!50001 SET character_set_client      = @saved_cs_client */;
/*!50001 SET character_set_results     = @saved_cs_results */;
/*!50001 SET collation_connection      = @saved_col_connection */;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;
