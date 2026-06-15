import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const JWT_SECRETS = process.env.JWT_SECRETS;

export const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // get the part after "Bearer "

  if (!token) {
    return res.status(401).json({ error: 'No token provided. Please log in.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRETS);
    req.user = decoded; // { id, email, role }
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token. Please log in again.' });
  }
};

// ── paste this right after your authenticateToken function ──
export function requireAdmin(req, res, next) {
  if (req.user.role !== 'Admin') {
    return res.status(403).json({ error: 'Admin access only.' });
  }
  next();
}

async function Login(inputpassword, email, supabase) {
  if (!email || !inputpassword) {
    return {
      success: false,
      statusCode: 400,
      error: 'Email and password are required.'
    };
  }

  const cleanEmail = email.toLowerCase().trim();

  const { data: user, error: fetchError } = await supabase
    .from('users')
    .select('id, email, role, password')
    .eq('email', cleanEmail)
    .maybeSingle();

  if (fetchError) {
    throw fetchError;
  }

  if (!user) {
    return {
      success: false,
      statusCode: 404,
      error: 'This account does not exist. Please register first.'
    };
  }

  const passwordMatch = await bcrypt
    .compare(inputpassword, user.password)
    .catch(() => false);

  const isMatch = passwordMatch || inputpassword === user.password;

  if (!isMatch) {
    return {
      success: false,
      statusCode: 401,
      error: 'Incorrect password.'
    };
  }

  const { password, ...safeUser } = user;

  const token = jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role
    },
    JWT_SECRETS,
    {
      expiresIn: '7d'
    }
  );

  return {
    success: true,
    statusCode: 200,
    message: 'Login successful.',
    token,
    user: safeUser
  };
}



export {
  Login
};
