-- Database structure (no data) of the live app before migrations/001. scripts/dev.sh loads
-- this into a local MariaDB, then applies migrations/ and adds sample data.

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
DROP TABLE IF EXISTS `announcement_properties`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `announcement_properties` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `announcement_id` int(10) unsigned NOT NULL,
  `property_id` int(10) unsigned NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ann_prop` (`announcement_id`,`property_id`),
  KEY `idx_ap_ann` (`announcement_id`),
  KEY `idx_ap_prop` (`property_id`),
  CONSTRAINT `fk_ap_ann` FOREIGN KEY (`announcement_id`) REFERENCES `announcements` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_ap_prop` FOREIGN KEY (`property_id`) REFERENCES `properties` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `announcement_reads`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `announcement_reads` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `announcement_id` int(10) unsigned NOT NULL,
  `tenant_user_id` int(10) unsigned NOT NULL,
  `read_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ann_read` (`announcement_id`,`tenant_user_id`),
  KEY `fk_ar_user` (`tenant_user_id`),
  CONSTRAINT `fk_ar_ann` FOREIGN KEY (`announcement_id`) REFERENCES `announcements` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_ar_user` FOREIGN KEY (`tenant_user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `announcements`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `announcements` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `landlord_id` int(10) unsigned NOT NULL,
  `subject` varchar(255) NOT NULL,
  `body` text NOT NULL,
  `target_all` tinyint(1) NOT NULL DEFAULT 0,
  `expires_at` date DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_ann_landlord` (`landlord_id`),
  KEY `idx_ann_created` (`created_at` DESC),
  CONSTRAINT `fk_ann_landlord` FOREIGN KEY (`landlord_id`) REFERENCES `landlord_profiles` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `audit_logs`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `audit_logs` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `user_id` int(10) unsigned DEFAULT NULL,
  `action` varchar(50) NOT NULL,
  `table_name` varchar(100) DEFAULT NULL,
  `record_id` int(10) unsigned DEFAULT NULL,
  `description` text DEFAULT NULL,
  `ip_address` varchar(45) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_audit_user` (`user_id`),
  KEY `idx_audit_created` (`created_at`),
  CONSTRAINT `fk_audit_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=27 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `bills`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `bills` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `contract_id` int(10) unsigned NOT NULL,
  `description` varchar(255) NOT NULL,
  `bill_type` enum('rent','water','electricity','other') NOT NULL DEFAULT 'rent',
  `bill_month` tinyint(3) unsigned DEFAULT NULL,
  `bill_year` smallint(5) unsigned DEFAULT NULL,
  `amount` decimal(12,2) NOT NULL,
  `due_date` date NOT NULL,
  `status` enum('pending','paid','overdue') NOT NULL DEFAULT 'pending',
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_bill_contract` (`contract_id`),
  KEY `idx_bill_status` (`status`),
  KEY `idx_bill_due_date` (`due_date`),
  CONSTRAINT `fk_bill_contract` FOREIGN KEY (`contract_id`) REFERENCES `contracts` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = '' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER trg_notify_tenant_new_bill
AFTER INSERT ON bills
FOR EACH ROW
BEGIN
    DECLARE v_tenant_user_id INT UNSIGNED;
    DECLARE v_desc VARCHAR(255);

    SELECT u.id INTO v_tenant_user_id
    FROM contracts c
    JOIN tenant_profiles tp ON tp.id = c.tenant_id
    JOIN users u ON u.id = tp.user_id
    WHERE c.id = NEW.contract_id AND c.status = 'active'
    LIMIT 1;

    IF v_tenant_user_id IS NOT NULL THEN
        SET v_desc = CONCAT('New bill: ', NEW.description, ' — ₱', NEW.amount);
        INSERT INTO notifications (user_id, title, body, type)
        VALUES (v_tenant_user_id, 'New Bill Posted', v_desc, 'bill');
    END IF;
END 
*/;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
DROP TABLE IF EXISTS `contracts`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `contracts` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `unit_id` int(10) unsigned NOT NULL,
  `tenant_id` int(10) unsigned NOT NULL,
  `start_date` date NOT NULL,
  `end_date` date NOT NULL,
  `monthly_rent` decimal(12,2) NOT NULL,
  `deposit` decimal(12,2) NOT NULL DEFAULT 0.00,
  `is_open_term` tinyint(1) NOT NULL DEFAULT 0,
  `minimum_months` tinyint(3) unsigned DEFAULT NULL,
  `contract_doc_url` text DEFAULT NULL,
  `doc_uploaded_at` datetime DEFAULT NULL,
  `tenant_ack` tinyint(1) NOT NULL DEFAULT 0,
  `tenant_ack_at` datetime DEFAULT NULL,
  `status` enum('active','terminated','expired','move_out_pending') NOT NULL DEFAULT 'active',
  `notes` text DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `contract_signed_date` date DEFAULT NULL,
  `move_in_date` date DEFAULT NULL,
  `move_out_date` date DEFAULT NULL,
  `move_out_notes` text DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_contract_unit` (`unit_id`),
  KEY `idx_contract_tenant` (`tenant_id`),
  KEY `idx_contract_status` (`status`),
  CONSTRAINT `fk_contract_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenant_profiles` (`id`),
  CONSTRAINT `fk_contract_unit` FOREIGN KEY (`unit_id`) REFERENCES `units` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = '' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER trg_prevent_double_active_contract
BEFORE INSERT ON contracts
FOR EACH ROW
BEGIN
    DECLARE active_count INT;
    IF NEW.status = 'active' THEN
        SELECT COUNT(*) INTO active_count
        FROM contracts
        WHERE unit_id = NEW.unit_id AND status = 'active';
        IF active_count > 0 THEN
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'This unit already has an active contract.';
        END IF;
    END IF;
END 
*/;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = '' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER trg_prevent_double_tenant_contract
BEFORE INSERT ON contracts
FOR EACH ROW
BEGIN
    DECLARE active_count INT;
    IF NEW.status = 'active' THEN
        SELECT COUNT(*) INTO active_count
        FROM contracts
        WHERE tenant_id = NEW.tenant_id AND status = 'active';
        IF active_count > 0 THEN
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'This tenant already has an active contract.';
        END IF;
    END IF;
END 
*/;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = '' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER trg_unit_occupied_on_contract
AFTER INSERT ON contracts
FOR EACH ROW
BEGIN
    IF NEW.status = 'active' THEN
        UPDATE units SET status = 'occupied' WHERE id = NEW.unit_id;
    END IF;
END 
*/;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = '' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER trg_sync_unit_status
AFTER UPDATE ON contracts
FOR EACH ROW
BEGIN
    IF NEW.status = 'active' THEN
        UPDATE units SET status = 'occupied' WHERE id = NEW.unit_id;
    ELSEIF NEW.status IN ('expired', 'terminated') THEN
        UPDATE units SET status = 'vacant' WHERE id = NEW.unit_id;
    END IF;
END 
*/;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
DROP TABLE IF EXISTS `email_verifications`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `email_verifications` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) NOT NULL,
  `token` varchar(100) NOT NULL,
  `new_email` varchar(255) NOT NULL,
  `expires_at` datetime NOT NULL,
  `created_at` datetime DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_token` (`token`),
  KEY `idx_user` (`user_id`)
) ENGINE=InnoDB AUTO_INCREMENT=6 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `landlord_profiles`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `landlord_profiles` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `user_id` int(10) unsigned NOT NULL,
  `landlord_code` char(8) NOT NULL,
  `business_name` varchar(255) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `user_id` (`user_id`),
  UNIQUE KEY `landlord_code` (`landlord_code`),
  KEY `idx_landlord_code` (`landlord_code`),
  CONSTRAINT `fk_lp_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `message_replies`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `message_replies` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `thread_id` int(10) unsigned NOT NULL,
  `sender_id` int(10) unsigned NOT NULL,
  `body` text NOT NULL,
  `is_read` tinyint(1) NOT NULL DEFAULT 0,
  `sent_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_mr_thread` (`thread_id`),
  KEY `idx_mr_sender` (`sender_id`),
  CONSTRAINT `fk_mr_sender` FOREIGN KEY (`sender_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_mr_thread` FOREIGN KEY (`thread_id`) REFERENCES `message_threads` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=15 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = '' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER trg_update_thread_on_reply
AFTER INSERT ON message_replies
FOR EACH ROW
BEGIN
    DECLARE v_landlord INT UNSIGNED;
    DECLARE v_tenant   INT UNSIGNED;

    SELECT landlord_id, tenant_id INTO v_landlord, v_tenant
    FROM message_threads WHERE id = NEW.thread_id;

    IF NEW.sender_id = v_landlord THEN
        -- Landlord sent → mark unread for tenant
        UPDATE message_threads
        SET last_reply_at = NEW.sent_at, is_read_tenant = 0
        WHERE id = NEW.thread_id;
    ELSE
        -- Tenant sent → mark unread for landlord
        UPDATE message_threads
        SET last_reply_at = NEW.sent_at, is_read_landlord = 0
        WHERE id = NEW.thread_id;
    END IF;
END 
*/;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
DROP TABLE IF EXISTS `message_threads`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `message_threads` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `subject` varchar(255) NOT NULL,
  `started_by` int(10) unsigned NOT NULL,
  `landlord_id` int(10) unsigned NOT NULL,
  `tenant_id` int(10) unsigned NOT NULL,
  `contract_id` int(10) unsigned DEFAULT NULL,
  `last_reply_at` datetime NOT NULL DEFAULT current_timestamp(),
  `is_read_landlord` tinyint(1) NOT NULL DEFAULT 0,
  `is_read_tenant` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `fk_mt_starter` (`started_by`),
  KEY `fk_mt_contract` (`contract_id`),
  KEY `idx_mt_landlord` (`landlord_id`),
  KEY `idx_mt_tenant` (`tenant_id`),
  KEY `idx_mt_last` (`last_reply_at` DESC),
  CONSTRAINT `fk_mt_contract` FOREIGN KEY (`contract_id`) REFERENCES `contracts` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_mt_landlord` FOREIGN KEY (`landlord_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_mt_starter` FOREIGN KEY (`started_by`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_mt_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=11 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `messages`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `messages` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `sender_id` int(10) unsigned NOT NULL,
  `recipient_id` int(10) unsigned NOT NULL,
  `contract_id` int(10) unsigned DEFAULT NULL,
  `subject` varchar(255) DEFAULT NULL,
  `body` text NOT NULL,
  `is_read` tinyint(1) NOT NULL DEFAULT 0,
  `sent_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `fk_msg_contract` (`contract_id`),
  KEY `idx_msg_sender` (`sender_id`),
  KEY `idx_msg_recipient` (`recipient_id`),
  KEY `idx_msg_unread` (`recipient_id`,`is_read`),
  CONSTRAINT `fk_msg_contract` FOREIGN KEY (`contract_id`) REFERENCES `contracts` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_msg_recipient` FOREIGN KEY (`recipient_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_msg_sender` FOREIGN KEY (`sender_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `move_out_checklists`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `move_out_checklists` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `contract_id` int(11) NOT NULL,
  `deposit_consumed` tinyint(1) NOT NULL DEFAULT 0,
  `deposit_consumed_amount` decimal(10,2) DEFAULT 0.00,
  `repair_status` enum('not_required','pending','cleared') DEFAULT 'not_required',
  `repair_notes` text DEFAULT NULL,
  `repair_proof_url` varchar(512) DEFAULT NULL,
  `deposit_status` enum('processing','ready','released') DEFAULT 'processing',
  `deposit_ready_at` datetime DEFAULT NULL,
  `completed_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT current_timestamp(),
  `created_at` datetime DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_contract` (`contract_id`),
  KEY `idx_contract` (`contract_id`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `notification_preferences`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `notification_preferences` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `user_id` int(10) unsigned NOT NULL,
  `email_new_bill` tinyint(1) NOT NULL DEFAULT 1,
  `email_payment_approved` tinyint(1) NOT NULL DEFAULT 1,
  `email_payment_rejected` tinyint(1) NOT NULL DEFAULT 1,
  `email_new_announcement` tinyint(1) NOT NULL DEFAULT 1,
  `email_contract_uploaded` tinyint(1) NOT NULL DEFAULT 1,
  `email_new_message` tinyint(1) NOT NULL DEFAULT 1,
  `email_ticket_reply` tinyint(1) NOT NULL DEFAULT 1,
  `sms_new_bill` tinyint(1) NOT NULL DEFAULT 0,
  `sms_payment_approved` tinyint(1) NOT NULL DEFAULT 0,
  `sms_new_announcement` tinyint(1) NOT NULL DEFAULT 0,
  `sms_phone` varchar(30) DEFAULT NULL,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `email_tenant_message` tinyint(1) NOT NULL DEFAULT 1,
  `email_contract_acknowledged` tinyint(1) NOT NULL DEFAULT 1,
  `email_payment_submitted` tinyint(1) NOT NULL DEFAULT 1,
  `email_new_tenant_joined` tinyint(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  UNIQUE KEY `user_id` (`user_id`),
  CONSTRAINT `fk_np_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=8 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `notifications`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `notifications` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `user_id` int(10) unsigned NOT NULL,
  `title` varchar(255) NOT NULL,
  `body` text DEFAULT NULL,
  `type` enum('bill','payment','message','reminder','system','announcement','contract','support') NOT NULL DEFAULT 'system',
  `is_read` tinyint(1) NOT NULL DEFAULT 0,
  `link` varchar(255) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_notif_user` (`user_id`),
  KEY `idx_notif_unread` (`user_id`,`is_read`),
  CONSTRAINT `fk_notif_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=46 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `password_resets`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `password_resets` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(10) unsigned NOT NULL,
  `token` varchar(100) NOT NULL,
  `expires_at` datetime NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_token` (`token`),
  UNIQUE KEY `uq_user` (`user_id`),
  CONSTRAINT `fk_pr_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=7 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `payments`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `payments` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `bill_id` int(10) unsigned NOT NULL,
  `amount_paid` decimal(12,2) NOT NULL,
  `proof_url` text DEFAULT NULL,
  `proof_public_id` varchar(255) DEFAULT NULL,
  `status` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  `notes` text DEFAULT NULL,
  `paid_at` datetime NOT NULL DEFAULT current_timestamp(),
  `reviewed_at` datetime DEFAULT NULL,
  `reviewed_by` int(10) unsigned DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `fk_pay_reviewer` (`reviewed_by`),
  KEY `idx_payment_bill` (`bill_id`),
  KEY `idx_payment_status` (`status`),
  CONSTRAINT `fk_pay_bill` FOREIGN KEY (`bill_id`) REFERENCES `bills` (`id`),
  CONSTRAINT `fk_pay_reviewer` FOREIGN KEY (`reviewed_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=23 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = '' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `trg_notify_landlord_payment` AFTER INSERT ON `payments` FOR EACH ROW BEGIN
    DECLARE v_landlord_user_id INT;
    DECLARE v_tenant_name VARCHAR(150);

    SELECT lu.id, u.full_name
    INTO v_landlord_user_id, v_tenant_name
    FROM payments py
    JOIN bills b ON b.id = py.bill_id
    JOIN contracts c ON c.id = b.contract_id
    JOIN tenant_profiles tp ON tp.id = c.tenant_id
    JOIN users u ON u.id = tp.user_id
    JOIN units un ON un.id = c.unit_id
    JOIN properties p ON p.id = un.property_id
    JOIN landlord_profiles lp ON lp.id = p.landlord_id
    JOIN users lu ON lu.id = lp.user_id
    WHERE py.id = NEW.id
    LIMIT 1;

    IF v_landlord_user_id IS NOT NULL THEN
        INSERT INTO notifications (user_id, title, body, type)
VALUES (
    v_landlord_user_id,
    'Payment Submitted',
    CONCAT(v_tenant_name, ' submitted a payment of ₱', CAST(NEW.amount_paid AS CHAR)),
    'payment'
);
    END IF;
END 
*/;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = '' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER trg_auto_close_bill
AFTER UPDATE ON payments
FOR EACH ROW
BEGIN
    DECLARE total_paid DECIMAL(12,2);
    DECLARE bill_amount DECIMAL(12,2);
    IF NEW.status = 'approved' THEN
        SELECT SUM(amount_paid) INTO total_paid
        FROM payments WHERE bill_id = NEW.bill_id AND status = 'approved';
        SELECT amount INTO bill_amount FROM bills WHERE id = NEW.bill_id;
        IF total_paid >= bill_amount THEN
            UPDATE bills SET status = 'paid' WHERE id = NEW.bill_id;
        END IF;
    END IF;
END 
*/;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
DROP TABLE IF EXISTS `properties`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `properties` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `landlord_id` int(10) unsigned NOT NULL,
  `name` varchar(255) NOT NULL,
  `address` text NOT NULL,
  `city` varchar(100) DEFAULT NULL,
  `country` varchar(100) DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_prop_landlord` (`landlord_id`),
  CONSTRAINT `fk_prop_landlord` FOREIGN KEY (`landlord_id`) REFERENCES `landlord_profiles` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `reminders`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `reminders` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `landlord_id` int(10) unsigned NOT NULL,
  `title` varchar(255) NOT NULL,
  `reminder_type` enum('water_reading','bill_generation','payment_collection','custom') NOT NULL DEFAULT 'custom',
  `day_of_month` tinyint(3) unsigned NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `last_sent_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_reminder_landlord` (`landlord_id`),
  CONSTRAINT `fk_reminder_landlord` FOREIGN KEY (`landlord_id`) REFERENCES `landlord_profiles` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `support_chat_messages`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `support_chat_messages` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `chat_id` int(11) NOT NULL,
  `sender_id` int(11) NOT NULL,
  `sender_role` enum('landlord','tenant','admin') NOT NULL,
  `body` text NOT NULL,
  `is_read` tinyint(1) NOT NULL DEFAULT 0,
  `sent_at` datetime DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_chat` (`chat_id`),
  CONSTRAINT `support_chat_messages_ibfk_1` FOREIGN KEY (`chat_id`) REFERENCES `support_chats` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `support_chats`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `support_chats` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) NOT NULL,
  `subject` varchar(255) NOT NULL,
  `status` enum('open','closed','converted') NOT NULL DEFAULT 'open',
  `ticket_id` int(11) DEFAULT NULL,
  `last_message_at` datetime DEFAULT current_timestamp(),
  `created_at` datetime DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_user` (`user_id`),
  KEY `idx_status` (`status`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `support_tickets`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `support_tickets` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `opened_by` int(10) unsigned NOT NULL,
  `title` varchar(255) NOT NULL,
  `category` enum('billing','technical','account','contract','other') NOT NULL DEFAULT 'other',
  `status` enum('open','in_progress','resolved') NOT NULL DEFAULT 'open',
  `priority` enum('low','normal','high') NOT NULL DEFAULT 'normal',
  `resolved_at` datetime DEFAULT NULL,
  `resolved_by` int(10) unsigned DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `fk_st_resolver` (`resolved_by`),
  KEY `idx_st_opener` (`opened_by`),
  KEY `idx_st_status` (`status`),
  KEY `idx_st_created` (`created_at` DESC),
  CONSTRAINT `fk_st_opener` FOREIGN KEY (`opened_by`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_st_resolver` FOREIGN KEY (`resolved_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `tenant_landlords`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `tenant_landlords` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `tenant_id` int(10) unsigned NOT NULL,
  `landlord_id` int(10) unsigned NOT NULL,
  `joined_at` datetime NOT NULL DEFAULT current_timestamp(),
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_tenant_landlord` (`tenant_id`,`landlord_id`),
  KEY `idx_tl_tenant` (`tenant_id`),
  KEY `idx_tl_landlord` (`landlord_id`),
  CONSTRAINT `fk_tl_landlord` FOREIGN KEY (`landlord_id`) REFERENCES `landlord_profiles` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_tl_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenant_profiles` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `tenant_profiles`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `tenant_profiles` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `user_id` int(10) unsigned NOT NULL,
  `joined_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `user_id` (`user_id`),
  CONSTRAINT `fk_tp_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `ticket_replies`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `ticket_replies` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `ticket_id` int(10) unsigned NOT NULL,
  `sender_id` int(10) unsigned NOT NULL,
  `body` text NOT NULL,
  `is_read` tinyint(1) NOT NULL DEFAULT 0,
  `sent_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_tr_ticket` (`ticket_id`),
  KEY `idx_tr_sender` (`sender_id`),
  CONSTRAINT `fk_tr_sender` FOREIGN KEY (`sender_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_tr_ticket` FOREIGN KEY (`ticket_id`) REFERENCES `support_tickets` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = '' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER trg_ticket_in_progress
AFTER INSERT ON ticket_replies
FOR EACH ROW
BEGIN
    DECLARE v_role VARCHAR(20);
    SELECT role INTO v_role FROM users WHERE id = NEW.sender_id;
    IF v_role = 'admin' THEN
        UPDATE support_tickets
        SET status = 'in_progress', updated_at = NOW()
        WHERE id = NEW.ticket_id AND status = 'open';
    END IF;
END 
*/;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
DROP TABLE IF EXISTS `units`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `units` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `property_id` int(10) unsigned NOT NULL,
  `unit_number` varchar(20) NOT NULL,
  `floor_num` smallint(6) DEFAULT NULL,
  `bedrooms` smallint(6) DEFAULT NULL,
  `bathrooms` smallint(6) DEFAULT NULL,
  `area_sqm` decimal(8,2) DEFAULT NULL,
  `rent_amount` decimal(12,2) NOT NULL,
  `status` enum('vacant','occupied','maintenance') NOT NULL DEFAULT 'vacant',
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_unit_in_property` (`property_id`,`unit_number`),
  KEY `idx_unit_status` (`status`),
  CONSTRAINT `fk_unit_property` FOREIGN KEY (`property_id`) REFERENCES `properties` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `users`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `users` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `email` varchar(255) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `full_name` varchar(150) NOT NULL,
  `phone` varchar(30) DEFAULT NULL,
  `role` enum('admin','landlord','tenant') NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `last_login_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `email_verified` tinyint(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`),
  KEY `idx_email` (`email`),
  KEY `idx_role` (`role`)
) ENGINE=InnoDB AUTO_INCREMENT=8 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = '' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER trg_create_notif_prefs
AFTER INSERT ON users
FOR EACH ROW
BEGIN
    INSERT IGNORE INTO notification_preferences (user_id) VALUES (NEW.id);
END 
*/;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
DROP TABLE IF EXISTS `v_landlord_summary`;
/*!50001 DROP VIEW IF EXISTS `v_landlord_summary`*/;
SET @saved_cs_client     = @@character_set_client;
SET character_set_client = utf8mb4;
/*!50001 CREATE VIEW `v_landlord_summary` AS SELECT
 NULL AS `landlord_id`,
 NULL AS `landlord_code`,
 NULL AS `landlord_name`,
 NULL AS `landlord_email`,
 NULL AS `total_properties`,
 NULL AS `total_units`,
 NULL AS `occupied_units`,
 NULL AS `vacant_units`,
 NULL AS `total_tenants`,
 NULL AS `pending_bills`,
 NULL AS `pending_payments`,
 NULL AS `unread_messages` */;
SET character_set_client = @saved_cs_client;
DROP TABLE IF EXISTS `v_tenant_dashboard`;
/*!50001 DROP VIEW IF EXISTS `v_tenant_dashboard`*/;
SET @saved_cs_client     = @@character_set_client;
SET character_set_client = utf8mb4;
/*!50001 CREATE VIEW `v_tenant_dashboard` AS SELECT
 NULL AS `tenant_id`,
 NULL AS `tenant_name`,
 NULL AS `email`,
 NULL AS `landlord_code`,
 NULL AS `landlord_name`,
 NULL AS `landlord_user_id`,
 NULL AS `property_name`,
 NULL AS `address`,
 NULL AS `unit_number`,
 NULL AS `contract_id`,
 NULL AS `start_date`,
 NULL AS `end_date`,
 NULL AS `monthly_rent`,
 NULL AS `deposit`,
 NULL AS `contract_status`,
 NULL AS `is_open_term`,
 NULL AS `minimum_months`,
 NULL AS `contract_doc_url`,
 NULL AS `tenant_ack` */;
SET character_set_client = @saved_cs_client;
DROP TABLE IF EXISTS `water_meter_readings`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `water_meter_readings` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `session_id` int(10) unsigned NOT NULL,
  `unit_id` int(10) unsigned NOT NULL,
  `is_owner_unit` tinyint(1) NOT NULL DEFAULT 0,
  `prev_reading` decimal(10,2) NOT NULL,
  `curr_reading` decimal(10,2) NOT NULL,
  `consumption` decimal(10,2) NOT NULL,
  `water_bill` decimal(12,2) NOT NULL,
  `pump_fee` decimal(12,2) NOT NULL,
  `total_amount` decimal(12,2) NOT NULL,
  `bill_id` int(10) unsigned DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_reading` (`session_id`,`unit_id`),
  KEY `fk_wmr_bill` (`bill_id`),
  KEY `idx_wmr_session` (`session_id`),
  KEY `idx_wmr_unit` (`unit_id`),
  CONSTRAINT `fk_wmr_bill` FOREIGN KEY (`bill_id`) REFERENCES `bills` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_wmr_session` FOREIGN KEY (`session_id`) REFERENCES `water_meter_sessions` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_wmr_unit` FOREIGN KEY (`unit_id`) REFERENCES `units` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `water_meter_sessions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `water_meter_sessions` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `property_id` int(10) unsigned NOT NULL,
  `session_month` tinyint(3) unsigned NOT NULL,
  `session_year` smallint(5) unsigned NOT NULL,
  `prev_reading_date` date NOT NULL,
  `curr_reading_date` date NOT NULL,
  `total_bill` decimal(12,2) NOT NULL,
  `overall_consumption` decimal(10,2) NOT NULL,
  `price_per_cubic` decimal(10,4) NOT NULL,
  `pump_total` decimal(12,2) NOT NULL DEFAULT 0.00,
  `number_of_units` smallint(5) unsigned NOT NULL,
  `pump_per_unit` decimal(10,4) NOT NULL,
  `status` enum('draft','billed') NOT NULL DEFAULT 'draft',
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_session` (`property_id`,`session_month`,`session_year`),
  KEY `idx_wms_property` (`property_id`),
  CONSTRAINT `fk_wms_property` FOREIGN KEY (`property_id`) REFERENCES `properties` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = '' */ ;
/*!50003 DROP PROCEDURE IF EXISTS `sp_create_contract` */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
DELIMITER ;;
CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_create_contract`(
    IN p_unit_id       INT UNSIGNED,
    IN p_tenant_id     INT UNSIGNED,
    IN p_start_date    DATE,
    IN p_end_date      DATE,
    IN p_monthly_rent  DECIMAL(12,2),
    IN p_deposit       DECIMAL(12,2),
    OUT p_contract_id  INT UNSIGNED,
    OUT p_error        VARCHAR(255)
)
BEGIN
    DECLARE v_unit_landlord INT UNSIGNED;
    DECLARE v_tenant_landlord INT UNSIGNED;

    SET p_error = NULL;

    -- Get landlord of the unit
    SELECT p.landlord_id INTO v_unit_landlord
    FROM units u JOIN properties p ON p.id = u.property_id
    WHERE u.id = p_unit_id;

    -- Get landlord of the tenant
    SELECT landlord_id INTO v_tenant_landlord
    FROM tenant_profiles WHERE id = p_tenant_id;

    -- Validate they belong to the same landlord
    IF v_unit_landlord IS NULL THEN
        SET p_error = 'Unit not found.';
    ELSEIF v_tenant_landlord IS NULL THEN
        SET p_error = 'Tenant not found.';
    ELSEIF v_unit_landlord != v_tenant_landlord THEN
        SET p_error = 'Tenant and unit belong to different landlords.';
    ELSE
        INSERT INTO contracts (unit_id, tenant_id, start_date, end_date, monthly_rent, deposit)
        VALUES (p_unit_id, p_tenant_id, p_start_date, p_end_date, p_monthly_rent, p_deposit);
        SET p_contract_id = LAST_INSERT_ID();
    END IF;
END
;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = '' */ ;
/*!50003 DROP PROCEDURE IF EXISTS `sp_generate_monthly_bills` */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
DELIMITER ;;
CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_generate_monthly_bills`()
BEGIN
    DECLARE done INT DEFAULT FALSE;
    DECLARE v_contract_id INT UNSIGNED;
    DECLARE v_rent DECIMAL(12,2);
    DECLARE v_count INT DEFAULT 0;

    DECLARE cur CURSOR FOR
        SELECT id, monthly_rent FROM contracts
        WHERE status = 'active'
          AND start_date <= CURDATE()
          AND end_date >= CURDATE();
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = TRUE;

    OPEN cur;
    read_loop: LOOP
        FETCH cur INTO v_contract_id, v_rent;
        IF done THEN LEAVE read_loop; END IF;

        -- Only generate if no rent bill exists for this month
        IF NOT EXISTS (
            SELECT 1 FROM bills
            WHERE contract_id = v_contract_id
              AND YEAR(created_at) = YEAR(NOW())
              AND MONTH(created_at) = MONTH(NOW())
              AND description LIKE 'Monthly Rent%'
        ) THEN
            INSERT INTO bills (contract_id, description, amount, due_date, status)
            VALUES (
                v_contract_id,
                CONCAT('Monthly Rent — ', DATE_FORMAT(NOW(), '%M %Y')),
                v_rent,
                DATE_ADD(DATE_FORMAT(NOW(), '%Y-%m-01'), INTERVAL 7 DAY),
                'pending'
            );
            SET v_count = v_count + 1;
        END IF;
    END LOOP;
    CLOSE cur;

    SELECT v_count AS bills_generated;
END
;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = '' */ ;
/*!50003 DROP PROCEDURE IF EXISTS `sp_mark_overdue_bills` */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
DELIMITER ;;
CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_mark_overdue_bills`()
BEGIN
    UPDATE bills SET status = 'overdue'
    WHERE status = 'pending' AND due_date < CURDATE();
    SELECT ROW_COUNT() AS bills_marked_overdue;
END
;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50001 DROP VIEW IF EXISTS `v_landlord_summary`*/;
/*!50001 SET @saved_cs_client          = @@character_set_client */;
/*!50001 SET @saved_cs_results         = @@character_set_results */;
/*!50001 SET @saved_col_connection     = @@collation_connection */;
/*!50001 SET character_set_client      = utf8mb4 */;
/*!50001 SET character_set_results     = utf8mb4 */;
/*!50001 SET collation_connection      = utf8mb4_general_ci */;
/*!50001 CREATE ALGORITHM=UNDEFINED */
/*!50013 DEFINER=`root`@`localhost` SQL SECURITY DEFINER */
/*!50001 VIEW `v_landlord_summary` AS select `lp`.`id` AS `landlord_id`,`lp`.`landlord_code` AS `landlord_code`,`u`.`full_name` AS `landlord_name`,`u`.`email` AS `landlord_email`,count(distinct `p`.`id`) AS `total_properties`,count(distinct `un`.`id`) AS `total_units`,sum(`un`.`status` = 'occupied') AS `occupied_units`,sum(`un`.`status` = 'vacant') AS `vacant_units`,count(distinct `tl`.`tenant_id`) AS `total_tenants`,sum(`b`.`status` = 'pending') AS `pending_bills`,sum(`py`.`status` = 'pending') AS `pending_payments`,sum(`m`.`is_read_landlord` = 0) AS `unread_messages` from ((((((((`landlord_profiles` `lp` join `users` `u` on(`u`.`id` = `lp`.`user_id`)) left join `properties` `p` on(`p`.`landlord_id` = `lp`.`id` and `p`.`is_active` = 1)) left join `units` `un` on(`un`.`property_id` = `p`.`id`)) left join `contracts` `c` on(`c`.`unit_id` = `un`.`id` and `c`.`status` = 'active')) left join `tenant_landlords` `tl` on(`tl`.`landlord_id` = `lp`.`id` and `tl`.`is_active` = 1)) left join `bills` `b` on(`b`.`contract_id` = `c`.`id`)) left join `payments` `py` on(`py`.`bill_id` = `b`.`id`)) left join `message_threads` `m` on(`m`.`landlord_id` = `u`.`id`)) group by `lp`.`id`,`lp`.`landlord_code`,`u`.`full_name`,`u`.`email` */;
/*!50001 SET character_set_client      = @saved_cs_client */;
/*!50001 SET character_set_results     = @saved_cs_results */;
/*!50001 SET collation_connection      = @saved_col_connection */;
/*!50001 DROP VIEW IF EXISTS `v_tenant_dashboard`*/;
/*!50001 SET @saved_cs_client          = @@character_set_client */;
/*!50001 SET @saved_cs_results         = @@character_set_results */;
/*!50001 SET @saved_col_connection     = @@collation_connection */;
/*!50001 SET character_set_client      = utf8mb4 */;
/*!50001 SET character_set_results     = utf8mb4 */;
/*!50001 SET collation_connection      = utf8mb4_general_ci */;
/*!50001 CREATE ALGORITHM=UNDEFINED */
/*!50013 DEFINER=`root`@`localhost` SQL SECURITY DEFINER */
/*!50001 VIEW `v_tenant_dashboard` AS select `tp`.`id` AS `tenant_id`,`u`.`full_name` AS `tenant_name`,`u`.`email` AS `email`,`lp`.`landlord_code` AS `landlord_code`,`lu`.`full_name` AS `landlord_name`,`lu`.`id` AS `landlord_user_id`,`p`.`name` AS `property_name`,`p`.`address` AS `address`,`un`.`unit_number` AS `unit_number`,`c`.`id` AS `contract_id`,`c`.`start_date` AS `start_date`,`c`.`end_date` AS `end_date`,`c`.`monthly_rent` AS `monthly_rent`,`c`.`deposit` AS `deposit`,`c`.`status` AS `contract_status`,`c`.`is_open_term` AS `is_open_term`,`c`.`minimum_months` AS `minimum_months`,`c`.`contract_doc_url` AS `contract_doc_url`,`c`.`tenant_ack` AS `tenant_ack` from (((((((`tenant_profiles` `tp` join `users` `u` on(`u`.`id` = `tp`.`user_id`)) left join `tenant_landlords` `tl` on(`tl`.`tenant_id` = `tp`.`id` and `tl`.`is_active` = 1)) left join `landlord_profiles` `lp` on(`lp`.`id` = `tl`.`landlord_id`)) left join `users` `lu` on(`lu`.`id` = `lp`.`user_id`)) left join `contracts` `c` on(`c`.`tenant_id` = `tp`.`id` and `c`.`status` = 'active')) left join `units` `un` on(`un`.`id` = `c`.`unit_id`)) left join `properties` `p` on(`p`.`id` = `un`.`property_id`)) */;
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

