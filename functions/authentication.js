import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const JWT_SECRETS = "851c67c962d6a25f0436becbe7ef6e43";

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

async function Login(inputpassword, email, supabase)
{
    
    // Validate both fields upfront
    if (!email || !inputpassword) {
        return { error: 'Email and password are required.' };
    }
    
    
    const cleanEmail = email.toLowerCase().trim();
    
    // ✅ Include password_hash in the select
    const { data: user, error: fetchError } = await supabase
      .from('users')
      .select('id, email, role, password')  // fetch the hashed password
      .eq('email', cleanEmail)
      .maybeSingle();
    
    if (fetchError) throw fetchError;
    
    if (!user) {
      return { 
        error: 'This account does not exist. Please register first. یہ اکاؤنٹ موجود نہیں ہے۔ پہلے رجسٹریشن کریں۔'
      };
    }
    
        // ✅ Compare provided password with stored hash
    const passwordMatch = await bcrypt.compare(inputpassword, user.password).catch(() => false);
        
        // Fallback for plaintext (old users)
    const isMatch = passwordMatch || inputpassword === user.password;
        
    if (!isMatch) {
      return { error: 'Incorrect password.' };
    }
    
    
    // ✅ Never send password_hash back to client
    const { password, ...safeUser } = user;
    
    // ✅ Issue a JWT token
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRETS,
      { expiresIn: '7d' }
    );
    
    return {
      message: 'Login successful.',
      token,
      user: safeUser
    };
    
}



export {
  Login
};
