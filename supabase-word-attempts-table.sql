-- Create word_attempts table for analytics and security monitoring
CREATE TABLE IF NOT EXISTS public.word_attempts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  match_id UUID, -- Nullable; populated for staked-match attempts
  game_date DATE NOT NULL,
  word VARCHAR(50) NOT NULL,
  is_valid BOOLEAN NOT NULL DEFAULT false,
  word_type VARCHAR(20) NOT NULL, -- 'target', 'bonus', 'match_valid', 'invalid', 'too_short'
  ip_address VARCHAR(15), -- Truncated for privacy
  attempted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Existing deployments need the new nullable column as well as fresh installs.
ALTER TABLE public.word_attempts ADD COLUMN IF NOT EXISTS match_id UUID;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_word_attempts_user_date ON public.word_attempts(user_id, game_date);
CREATE INDEX IF NOT EXISTS idx_word_attempts_match_id ON public.word_attempts(match_id);
CREATE INDEX IF NOT EXISTS idx_word_attempts_date ON public.word_attempts(game_date);
CREATE INDEX IF NOT EXISTS idx_word_attempts_word_type ON public.word_attempts(word_type);
CREATE INDEX IF NOT EXISTS idx_word_attempts_attempted_at ON public.word_attempts(attempted_at);

-- Enable Row Level Security (RLS)
ALTER TABLE public.word_attempts ENABLE ROW LEVEL SECURITY;

-- Create policies
-- Users can only see their own attempts
CREATE POLICY "Users can view own word attempts" ON public.word_attempts
  FOR SELECT USING (auth.uid() = user_id);

-- Only authenticated users can insert their own attempts (API will handle this)
-- For now, allow all inserts since the API handles validation
CREATE POLICY "Allow API to insert word attempts" ON public.word_attempts
  FOR INSERT WITH CHECK (true);

-- Prevent direct updates/deletes from clients
CREATE POLICY "Prevent direct updates" ON public.word_attempts
  FOR UPDATE USING (false);
CREATE POLICY "Prevent direct deletes" ON public.word_attempts
  FOR DELETE USING (false);

-- Grant necessary permissions
GRANT SELECT, INSERT ON public.word_attempts TO authenticated;
GRANT SELECT, INSERT ON public.word_attempts TO anon; -- For anonymous users

-- Optional: Create a view for analytics (admin only)
CREATE OR REPLACE VIEW public.word_attempts_analytics AS
SELECT 
  game_date,
  word_type,
  COUNT(*) as attempt_count,
  COUNT(DISTINCT user_id) as unique_users,
  COUNT(DISTINCT ip_address) as unique_ips,
  AVG(CASE WHEN is_valid THEN 1 ELSE 0 END) as success_rate
FROM public.word_attempts 
GROUP BY game_date, word_type
ORDER BY game_date DESC, word_type;

-- Restrict analytics view to admin users only
ALTER TABLE public.word_attempts_analytics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Only admins can view analytics" ON public.word_attempts_analytics
  FOR SELECT USING (auth.jwt() ->> 'role' = 'admin');
