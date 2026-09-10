alter table users
  add column personal_prompt text not null default ''
  check (char_length(personal_prompt) <= 4000);
