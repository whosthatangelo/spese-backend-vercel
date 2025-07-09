// backend/middleware/auth.js
import pg from 'pg';
const db = new pg.Pool({ connectionString: process.env.POSTGRES_URL });

/**
 * Middleware per verificare i permessi dell'utente
 * @param {string} resource - Risorsa da verificare (es: 'expenses', 'users', 'companies')
 * @param {string} action - Azione da verificare (es: 'create', 'read', 'update', 'delete')
 * @param {string} scope - Scope dell'azione (es: 'own', 'company', 'global') - opzionale
 */
export function requirePermission(resource, action, scope = null) {
  return async (req, res, next) => {
    try {
      const { userId, companyId } = req;

      if (!userId) {
        return res.status(401).json({ error: 'Utente non autenticato' });
      }

      // Ottieni il ruolo dell'utente per questa azienda
      const roleQuery = await db.query(`
        SELECT r.name, r.permissions, uc.role_id
        FROM user_companies uc
        JOIN roles r ON r.id = uc.role_id
        WHERE uc.utente_id = $1 AND uc.azienda_id = $2
      `, [userId, companyId]);

      if (roleQuery.rows.length === 0) {
        return res.status(403).json({ error: 'Utente non autorizzato per questa azienda' });
      }

      const { name: roleName, permissions } = roleQuery.rows[0];
      req.userRole = roleName;
      req.userPermissions = permissions;

      // Verifica se il ruolo ha il permesso richiesto
      const resourcePermissions = permissions[resource];
      if (!resourcePermissions || !resourcePermissions[action]) {
        return res.status(403).json({ 
          error: `Permesso negato: ${action} su ${resource}`,
          userRole: roleName 
        });
      }

      // Verifica lo scope se specificato
      if (scope && resourcePermissions.scope && resourcePermissions.scope !== scope) {
        // Se richiede scope 'own' ma l'utente ha scope 'company', permettilo
        if (scope === 'own' && resourcePermissions.scope === 'company') {
          // OK
        } else if (scope === 'company' && resourcePermissions.scope === 'global') {
          // OK  
        } else {
          return res.status(403).json({ 
            error: `Scope non autorizzato: richiesto ${scope}, disponibile ${resourcePermissions.scope}`,
            userRole: roleName 
          });
        }
      }

      console.log(`✅ Permesso autorizzato: ${roleName} può ${action} su ${resource}`);
      next();

    } catch (error) {
      console.error('❌ Errore verifica permessi:', error);
      res.status(500).json({ error: 'Errore interno verifica autorizzazioni' });
    }
  };
}

/**
 * Middleware per verificare se l'utente è Super Admin
 */
export function requireSuperAdmin(req, res, next) {
  return requirePermission('companies', 'create')(req, res, next);
}

/**
 * Middleware per verificare se l'utente è Admin Azienda o superiore
 */
export function requireAdminAzienda(req, res, next) {
  return requirePermission('users', 'assign_roles')(req, res, next);
}

/**
 * Ottiene i permessi dell'utente per il frontend
 */
export async function getUserPermissions(userId, companyId) {
  try {
    const result = await db.query(`
      SELECT r.name, r.permissions
      FROM user_companies uc
      JOIN roles r ON r.id = uc.role_id
      WHERE uc.utente_id = $1 AND uc.azienda_id = $2
    `, [userId, companyId]);

    if (result.rows.length === 0) {
      return { role: 'none', permissions: {} };
    }

    return {
      role: result.rows[0].name,
      permissions: result.rows[0].permissions
    };
  } catch (error) {
    console.error('❌ Errore getUserPermissions:', error);
    return { role: 'none', permissions: {} };
  }
}