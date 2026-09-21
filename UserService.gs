/**
 * UserService.gs
 * Phase 14 deliverable. Admin-only: user accounts, roles, and role->
 * permission assignment.
 *
 * ES5 only.
 *
 * Every read here explicitly lists columns rather than SELECT * on `users` -
 * password_hash must never reach the client, even though withErrorHandling_/
 * successResponse_ would happily serialize it if it were present in a row
 * (spec section 28's "never expose... to users" applies to stored secrets,
 * not just SQL errors).
 *
 * There is no dedicated 'roles.edit'/'permissions.edit' permission key in
 * seed.sql's permissions table - role and permission management is gated on
 * 'users.edit', the closest seeded admin capability.
 */

var UserService = (function () {

  var USER_COLUMNS = 'user_id, username, full_name, email, phone, role_id, is_active, last_login_at, created_at, updated_at';

  function getUser_(userId, conn) {
    var rows = DatabaseService.executeQuery(
      'SELECT u.' + USER_COLUMNS.split(', ').join(', u.') + ', r.role_name ' +
      'FROM users u JOIN roles r ON r.role_id = u.role_id WHERE u.user_id = ? LIMIT 1',
      [userId],
      conn
    );
    return rows.length > 0 ? rows[0] : null;
  }

  // ---------------------------------------------------------------------
  // Users
  // ---------------------------------------------------------------------

  function createUser(sessionId, input) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'users.edit')) {
      return errorResponse_('You do not have permission to create users.');
    }
    if (!input || !isNonEmptyString_(input.username) || !isNonEmptyString_(input.fullName)) {
      return errorResponse_('username and fullName are required.');
    }
    if (!isNonEmptyString_(input.initialPassword) || input.initialPassword.length < 8) {
      return errorResponse_('initialPassword is required and must be at least 8 characters.');
    }
    if (!isPositiveInteger_(input.roleId)) { return errorResponse_('A valid roleId is required.'); }

    var existing = DatabaseService.executeQuery('SELECT user_id FROM users WHERE username = ?', [input.username]);
    if (existing.length > 0) { return errorResponse_('This username is already taken.'); }
    var roleRows = DatabaseService.executeQuery('SELECT role_id FROM roles WHERE role_id = ? AND is_active = 1', [input.roleId]);
    if (roleRows.length === 0) { return errorResponse_('Role not found or is inactive.'); }

    var passwordHash = AuthService.hashPassword(input.initialPassword);

    var newUserId = DatabaseService.executeTransaction(function (conn) {
      var userId = DatabaseService.executeInsert(
        'INSERT INTO users (username, password_hash, full_name, email, phone, role_id, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)',
        [input.username, passwordHash, input.fullName, input.email || null, input.phone || null, input.roleId],
        conn
      );
      DatabaseService.executeInsert(
        "INSERT INTO audit_logs (user_id, action, module, record_id, new_value) VALUES (?, 'Create', 'Users', ?, ?)",
        [user.userId, String(userId), JSON.stringify({ username: input.username, roleId: input.roleId })],
        conn
      );
      return userId;
    });

    return successResponse_(getUser_(newUserId, null), 'User created.');
  }

  /** Whitelisted fields: fullName, email, phone, roleId. Not username. */
  function updateUser(sessionId, userId, input) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'users.edit')) {
      return errorResponse_('You do not have permission to update users.');
    }
    var target = getUser_(userId, null);
    if (!target) { return errorResponse_('User not found.'); }
    if (!input) { return errorResponse_('No fields provided to update.'); }

    var setClauses = [];
    var params = [];
    if (typeof input.fullName !== 'undefined') {
      if (!isNonEmptyString_(input.fullName)) { return errorResponse_('fullName cannot be empty.'); }
      setClauses.push('full_name = ?'); params.push(input.fullName);
    }
    if (typeof input.email !== 'undefined') { setClauses.push('email = ?'); params.push(input.email || null); }
    if (typeof input.phone !== 'undefined') { setClauses.push('phone = ?'); params.push(input.phone || null); }
    if (typeof input.roleId !== 'undefined') {
      if (!isPositiveInteger_(input.roleId)) { return errorResponse_('roleId must be a positive integer.'); }
      var roleRows = DatabaseService.executeQuery('SELECT role_id FROM roles WHERE role_id = ? AND is_active = 1', [input.roleId]);
      if (roleRows.length === 0) { return errorResponse_('Role not found or is inactive.'); }
      setClauses.push('role_id = ?'); params.push(input.roleId);
    }
    if (setClauses.length === 0) { return errorResponse_('No recognized fields provided to update.'); }
    params.push(userId);

    DatabaseService.executeTransaction(function (conn) {
      DatabaseService.executeUpdate('UPDATE users SET ' + setClauses.join(', ') + ' WHERE user_id = ?', params, conn);
      DatabaseService.executeInsert(
        "INSERT INTO audit_logs (user_id, action, module, record_id, new_value) VALUES (?, 'Update', 'Users', ?, ?)",
        [user.userId, String(userId), JSON.stringify(input)],
        conn
      );
      return null;
    });

    return successResponse_(getUser_(userId, null), 'User updated.');
  }

  function setUserActive(sessionId, userId, isActive) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'users.edit')) {
      return errorResponse_('You do not have permission to update users.');
    }
    var target = getUser_(userId, null);
    if (!target) { return errorResponse_('User not found.'); }
    if (Number(userId) === Number(user.userId) && !isActive) {
      return errorResponse_('You cannot deactivate your own account.');
    }
    var newValue = isActive ? 1 : 0;

    DatabaseService.executeTransaction(function (conn) {
      DatabaseService.executeUpdate('UPDATE users SET is_active = ? WHERE user_id = ?', [newValue, userId], conn);
      if (!isActive) {
        DatabaseService.executeUpdate('UPDATE user_sessions SET is_valid = 0 WHERE user_id = ?', [userId], conn);
      }
      DatabaseService.executeInsert(
        "INSERT INTO audit_logs (user_id, action, module, record_id, old_value, new_value) VALUES (?, 'Status Change', 'Users', ?, ?, ?)",
        [user.userId, String(userId), JSON.stringify({ isActive: Number(target.is_active) === 1 }), JSON.stringify({ isActive: isActive })],
        conn
      );
      return null;
    });

    return successResponse_(getUser_(userId, null), isActive ? 'User activated.' : 'User deactivated.');
  }

  /** Admin-triggered reset - distinct from the self-service change-password
   *  flow a future Login/Profile screen might add (not in scope here). */
  function resetUserPassword(sessionId, userId, newPassword) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'users.edit')) {
      return errorResponse_('You do not have permission to reset passwords.');
    }
    var target = getUser_(userId, null);
    if (!target) { return errorResponse_('User not found.'); }
    if (!isNonEmptyString_(newPassword) || newPassword.length < 8) {
      return errorResponse_('newPassword must be at least 8 characters.');
    }

    var passwordHash = AuthService.hashPassword(newPassword);
    DatabaseService.executeTransaction(function (conn) {
      DatabaseService.executeUpdate('UPDATE users SET password_hash = ? WHERE user_id = ?', [passwordHash, userId], conn);
      DatabaseService.executeUpdate('UPDATE user_sessions SET is_valid = 0 WHERE user_id = ?', [userId], conn);
      DatabaseService.executeInsert(
        "INSERT INTO audit_logs (user_id, action, module, record_id) VALUES (?, 'Update', 'Users', ?)",
        [user.userId, String(userId)],
        conn
      );
      return null;
    });

    return successResponse_(null, 'Password reset. The user has been signed out of all sessions.');
  }

  function getUser(sessionId, userId) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'users.view')) {
      return errorResponse_('You do not have permission to view users.');
    }
    if (!isPositiveInteger_(userId)) { return errorResponse_('A valid userId is required.'); }
    var target = getUser_(userId, null);
    if (!target) { return errorResponse_('User not found.'); }
    return successResponse_(target);
  }

  function listUsers(sessionId, filters, page, pageSize) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'users.view')) {
      return errorResponse_('You do not have permission to view users.');
    }
    filters = filters || {};
    var pageNum = isPositiveInteger_(page) ? page : 1;
    var size = isPositiveInteger_(pageSize) ? pageSize : 25;
    if (size > 200) { size = 200; }

    var where = ['1 = 1'];
    var params = [];
    if (isPositiveInteger_(filters.roleId)) { where.push('u.role_id = ?'); params.push(filters.roleId); }
    if (typeof filters.isActive === 'boolean') { where.push('u.is_active = ?'); params.push(filters.isActive ? 1 : 0); }
    if (isNonEmptyString_(filters.search)) {
      where.push('(u.username LIKE ? OR u.full_name LIKE ?)');
      params.push('%' + filters.search + '%', '%' + filters.search + '%');
    }
    var whereSql = 'WHERE ' + where.join(' AND ');

    var countRows = DatabaseService.executeQuery('SELECT COUNT(*) AS total FROM users u ' + whereSql, params);
    var total = Number(countRows[0].total);

    var rows = DatabaseService.executeQuery(
      'SELECT u.' + USER_COLUMNS.split(', ').join(', u.') + ', r.role_name ' +
      'FROM users u JOIN roles r ON r.role_id = u.role_id ' +
      whereSql + ' ORDER BY u.user_id LIMIT ? OFFSET ?',
      params.concat([size, (pageNum - 1) * size])
    );

    return successResponse_({
      rows: rows, page: pageNum, pageSize: size, total: total, totalPages: Math.max(1, Math.ceil(total / size))
    });
  }

  // ---------------------------------------------------------------------
  // Roles & permissions
  // ---------------------------------------------------------------------

  function createRole(sessionId, roleName, description) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'users.edit')) {
      return errorResponse_('You do not have permission to manage roles.');
    }
    if (!isNonEmptyString_(roleName)) { return errorResponse_('roleName is required.'); }
    var existing = DatabaseService.executeQuery('SELECT role_id FROM roles WHERE role_name = ?', [roleName]);
    if (existing.length > 0) { return errorResponse_('A role with this name already exists.'); }

    var newRoleId = DatabaseService.executeTransaction(function (conn) {
      var roleId = DatabaseService.executeInsert(
        'INSERT INTO roles (role_name, description) VALUES (?, ?)',
        [roleName, description || null],
        conn
      );
      DatabaseService.executeInsert(
        "INSERT INTO audit_logs (user_id, action, module, record_id, new_value) VALUES (?, 'Create', 'Users', ?, ?)",
        [user.userId, String(roleId), JSON.stringify({ roleName: roleName })],
        conn
      );
      return roleId;
    });

    return successResponse_(DatabaseService.executeQuery('SELECT * FROM roles WHERE role_id = ?', [newRoleId])[0], 'Role created.');
  }

  function updateRole(sessionId, roleId, input) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'users.edit')) {
      return errorResponse_('You do not have permission to manage roles.');
    }
    var roleRows = DatabaseService.executeQuery('SELECT * FROM roles WHERE role_id = ?', [roleId]);
    if (roleRows.length === 0) { return errorResponse_('Role not found.'); }
    if (!input) { return errorResponse_('No fields provided to update.'); }

    var setClauses = [];
    var params = [];
    if (typeof input.description !== 'undefined') { setClauses.push('description = ?'); params.push(input.description || null); }
    if (typeof input.isActive === 'boolean') { setClauses.push('is_active = ?'); params.push(input.isActive ? 1 : 0); }
    if (setClauses.length === 0) { return errorResponse_('No recognized fields provided to update.'); }
    params.push(roleId);

    DatabaseService.executeUpdate('UPDATE roles SET ' + setClauses.join(', ') + ' WHERE role_id = ?', params);
    return successResponse_(DatabaseService.executeQuery('SELECT * FROM roles WHERE role_id = ?', [roleId])[0], 'Role updated.');
  }

  function listRoles(sessionId) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'users.view')) {
      return errorResponse_('You do not have permission to view roles.');
    }
    return successResponse_(DatabaseService.executeQuery('SELECT * FROM roles ORDER BY role_name', []));
  }

  function listPermissions(sessionId) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'users.view')) {
      return errorResponse_('You do not have permission to view permissions.');
    }
    return successResponse_(DatabaseService.executeQuery('SELECT * FROM permissions ORDER BY module, permission_key', []));
  }

  function getRolePermissions(sessionId, roleId) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'users.view')) {
      return errorResponse_('You do not have permission to view role permissions.');
    }
    if (!isPositiveInteger_(roleId)) { return errorResponse_('A valid roleId is required.'); }
    var rows = DatabaseService.executeQuery(
      'SELECT p.permission_id, p.permission_key, p.module, p.description ' +
      'FROM role_permissions rp JOIN permissions p ON p.permission_id = rp.permission_id ' +
      'WHERE rp.role_id = ? ORDER BY p.module, p.permission_key',
      [roleId]
    );
    return successResponse_(rows);
  }

  /** Replaces a role's ENTIRE permission set with permissionIds (full
   *  overwrite, not a merge - the caller sends the complete desired set,
   *  same contract as a checkbox-grid admin screen would naturally produce). */
  function setRolePermissions(sessionId, roleId, permissionIds) {
    var user = AuthService.validateSession(sessionId);
    if (!user) { return errorResponse_('Session expired. Please log in again.'); }
    if (!AuthService.hasPermission(user.userId, 'users.edit')) {
      return errorResponse_('You do not have permission to manage role permissions.');
    }
    if (!isPositiveInteger_(roleId)) { return errorResponse_('A valid roleId is required.'); }
    var roleRows = DatabaseService.executeQuery('SELECT role_id FROM roles WHERE role_id = ?', [roleId]);
    if (roleRows.length === 0) { return errorResponse_('Role not found.'); }
    if (!permissionIds || Object.prototype.toString.call(permissionIds) !== '[object Array]') {
      return errorResponse_('permissionIds must be an array (use an empty array to clear all permissions).');
    }
    for (var i = 0; i < permissionIds.length; i++) {
      if (!isPositiveInteger_(permissionIds[i])) { return errorResponse_('permissionIds must all be positive integers.'); }
    }

    DatabaseService.executeTransaction(function (conn) {
      DatabaseService.executeUpdate('DELETE FROM role_permissions WHERE role_id = ?', [roleId], conn);
      for (var j = 0; j < permissionIds.length; j++) {
        DatabaseService.executeUpdate(
          'INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
          [roleId, permissionIds[j]],
          conn
        );
      }
      DatabaseService.executeInsert(
        "INSERT INTO audit_logs (user_id, action, module, record_id, new_value) VALUES (?, 'Update', 'Users', ?, ?)",
        [user.userId, String(roleId), JSON.stringify({ permissionIds: permissionIds })],
        conn
      );
      return null;
    });

    return successResponse_(getRolePermissions(sessionId, roleId).data, 'Role permissions updated.');
  }

  return {
    createUser: withErrorHandling_(createUser),
    updateUser: withErrorHandling_(updateUser),
    setUserActive: withErrorHandling_(setUserActive),
    resetUserPassword: withErrorHandling_(resetUserPassword),
    getUser: withErrorHandling_(getUser),
    listUsers: withErrorHandling_(listUsers),

    createRole: withErrorHandling_(createRole),
    updateRole: withErrorHandling_(updateRole),
    listRoles: withErrorHandling_(listRoles),
    listPermissions: withErrorHandling_(listPermissions),
    getRolePermissions: withErrorHandling_(getRolePermissions),
    setRolePermissions: withErrorHandling_(setRolePermissions)
  };
})();
