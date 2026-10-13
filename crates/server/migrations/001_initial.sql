create table users (
    id            bigserial primary key,
    user_key      text not null unique,
    created_at    timestamptz not null default now(),
    last_login_at timestamptz not null default now()
);

create table account_preferences (
    user_id bigint primary key references users(id) on delete cascade,
    meal_place text not null default 'dorm' check (meal_place in ('dorm', 'staff')),
    timetable_display text not null default 'fit' check (timetable_display in ('full', 'fit')),
    semester_display text not null default 'current' check (semester_display in ('current', 'all')),
    alert_leads integer[] not null default array[60] check (cardinality(alert_leads) <= 5 and alert_leads <@ array[1440, 180, 60, 10, 0]),
    midnight text not null default 'prev' check (midnight in ('prev', 'same')),
    show_undated_assignments boolean not null default false,
    updated_at timestamptz not null default now()
);

create table attendance_receipts (
    user_id      bigint not null references users(id) on delete cascade,
    school_date  date not null,
    lecture_key  text not null,
    course_code  text,
    course_name  text not null,
    lecture_time text not null,
    kind         text not null check (kind in ('present', 'late', 'excused')),
    confirmed_at timestamptz not null,
    primary key (user_id, school_date, lecture_key)
);
create index attendance_receipts_date on attendance_receipts(school_date);

create table assignment_snapshots (
    user_id          bigint not null references users (id) on delete cascade,
    cmid             bigint not null,
    course_id        bigint not null,
    name             text not null,
    first_due_at     timestamptz,
    first_intro_html text not null default '',
    due_at           timestamptz,
    modified_at      timestamptz,
    first_seen_at    timestamptz not null default now(),
    last_changed_at  timestamptz,
    change_count     integer not null default 0,
    primary key (user_id, cmid)
);

create table item_checks (
    user_id    bigint not null references users (id) on delete cascade,
    item_key   text not null,
    done       boolean not null,
    updated_at timestamptz not null default now(),
    primary key (user_id, item_key)
);

create table seat_sessions (
    id           bigserial primary key,
    user_id      bigint not null references users (id) on delete cascade,
    building     text not null,
    room_no      integer not null,
    room_name    text not null,
    seat_no      integer not null,
    period       text not null default 'semester',
    started_at   timestamptz not null,
    start_source text not null,
    expires_at   timestamptz not null,
    extend_count integer not null default 0,
    ended_at     timestamptz,
    end_source   text,
    created_at   timestamptz not null default now()
);
create unique index seat_sessions_one_active on seat_sessions (user_id) where ended_at is null;

create table seat_state (
    building    text not null,
    room_no     integer not null,
    seat_no     integer not null,
    state       text not null,
    since       timestamptz not null,
    since_known boolean not null default false,
    primary key (building, room_no, seat_no)
);

create table seat_events (
    id         bigserial primary key,
    building   text not null,
    room_no    integer not null,
    seat_no    integer not null,
    from_state text,
    to_state   text not null,
    at         timestamptz not null default now()
);
create index seat_events_room_at on seat_events (building, room_no, at desc);

create table seat_watch_meta (
    id           integer primary key default 1 check (id = 1),
    last_poll_at timestamptz not null
);

create table auth_sessions (
    token_hash text primary key,
    family_hash text not null,
    user_id bigint not null references users(id) on delete cascade,
    expires_at timestamptz not null,
    revoked_at timestamptz,
    logout_all_at timestamptz
);
create index auth_sessions_user on auth_sessions(user_id);
create index auth_sessions_family on auth_sessions(family_hash);

create table remembered_sessions (
    token_hash text primary key references auth_sessions(token_hash) on delete cascade,
    user_id    bigint not null references users (id) on delete cascade,
    nonce      bytea not null,
    ciphertext bytea not null,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null
);
create index remembered_sessions_user on remembered_sessions (user_id);

create table todos (
    id         bigserial primary key,
    user_id    bigint not null references users (id) on delete cascade,
    course_id  bigint,
    parent_key text,
    title      text not null check (char_length(title) between 1 and 200),
    note       text not null default '' check (char_length(note) <= 2000),
    due        timestamptz,
    all_day    boolean not null default true,
    done_at    timestamptz,
    notify     boolean not null default true,
    alert_leads integer[] check (cardinality(alert_leads) <= 5 and alert_leads <@ array[1440, 180, 60, 10, 0]),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index todos_user_due on todos (user_id, due);

create table item_alerts_off (
    user_id    bigint not null references users (id) on delete cascade,
    item_key   text not null,
    created_at timestamptz not null default now(),
    primary key (user_id, item_key)
);

create table item_alert_leads (
    user_id    bigint not null references users (id) on delete cascade,
    item_key   text not null,
    leads      integer[] not null check (cardinality(leads) <= 5 and leads <@ array[1440, 180, 60, 10, 0]),
    primary key (user_id, item_key)
);

create table notices_seen (
    user_id bigint not null references users (id) on delete cascade,
    url     text not null,
    seen_at timestamptz not null default now(),
    primary key (user_id, url)
);

create table background_sessions (
    user_id bigint primary key references users(id) on delete cascade,
    last_poll_at timestamptz,
    next_poll_at timestamptz not null default now(),
    poll_token text,
    poll_until timestamptz,
    last_error text,
    snapshot jsonb
);
create table reminder_schedule (
    user_id bigint primary key references background_sessions(user_id) on delete cascade,
    revision bigint not null default 1,
    scheduled_revision bigint not null default 0,
    next_check_at timestamptz not null default now()
);
create index reminder_schedule_due on reminder_schedule(next_check_at);

create table background_devices (
    id text primary key,
    user_id bigint not null references background_sessions(user_id) on delete cascade,
    session_hash text not null references auth_sessions(token_hash) on delete cascade,
    nonce bytea not null,
    ciphertext bytea not null,
    expires_at timestamptz not null default now() + interval '14 days',
    unique (id, session_hash)
);
create index background_devices_user on background_devices(user_id);
create index background_devices_login on background_devices(session_hash);

create table notification_devices (
    id text primary key,
    user_id bigint not null references users(id) on delete cascade,
    session_hash text not null,
    kind text not null check (kind in ('web','fcm','apns')),
    destination jsonb not null,
    seat_leads integer[] not null,
    classroom_alerts boolean not null default false,
    classroom_epoch text not null,
    notice_keys text[],
    expires_at timestamptz not null default now() + interval '90 days',
    last_error text,
    foreign key (id, session_hash) references background_devices(id, session_hash) on update cascade on delete cascade
);
create index notification_devices_user on notification_devices(user_id);
create index notification_devices_login on notification_devices(session_hash);
create table notification_outbox (
    device_id text not null references notification_devices(id) on delete cascade,
    event_key text not null,
    payload jsonb not null,
    due_at timestamptz not null,
    expires_at timestamptz not null,
    attempts integer not null default 0,
    next_try_at timestamptz not null default now(),
    sent_at timestamptz,
    claim_token text,
    claim_until timestamptz,
    primary key (device_id, event_key)
);
create index notification_outbox_due on notification_outbox(due_at) where sent_at is null;

create table calendar_archives (
    user_id bigint primary key references users(id) on delete cascade,
    school_data jsonb not null,
    updated_at bigint not null,
    current_updated_at bigint not null,
    initialized boolean not null default false
);

create table school_records (
    user_id bigint primary key references users(id) on delete cascade,
    data jsonb not null default '{}',
    metadata jsonb not null default '{}'
);

create function bump_account_revision() returns trigger language plpgsql as $$
declare uid bigint; section text;
begin
    if TG_OP = 'UPDATE' and new is not distinct from old then return new; end if;
    uid := case when TG_OP = 'DELETE' then old.user_id else new.user_id end;
    if not exists (select 1 from users where id=uid) then return null; end if;
    section := TG_ARGV[0];
    insert into school_records(user_id) values(uid) on conflict do nothing;
    update school_records set metadata=jsonb_set(metadata,array[section],
        coalesce(metadata->section,'{}'::jsonb) || jsonb_build_object('revision',coalesce((metadata->section->>'revision')::bigint,0)+1))
        where user_id=uid;
    return null;
end $$;
create trigger preferences_revision after insert or update or delete on account_preferences for each row execute function bump_account_revision('preferences');
create trigger todos_revision after insert or update or delete on todos for each row execute function bump_account_revision('todos');
create trigger checks_revision after insert or update or delete on item_checks for each row execute function bump_account_revision('items');
create trigger alerts_revision after insert or update or delete on item_alerts_off for each row execute function bump_account_revision('items');
create trigger leads_revision after insert or update or delete on item_alert_leads for each row execute function bump_account_revision('items');
create trigger seat_revision after insert or update or delete on seat_sessions
for each row execute function bump_account_revision('seat');

create function queue_reminder_schedule() returns trigger language plpgsql as $$
declare uid bigint; previous jsonb; current_value jsonb;
begin
    uid := case when TG_OP = 'DELETE' then old.user_id else new.user_id end;
    if not exists(select 1 from background_sessions where user_id=uid) then return null; end if;
    if TG_OP = 'UPDATE' then
        previous := to_jsonb(old);
        current_value := to_jsonb(new);
        case TG_TABLE_NAME
            when 'account_preferences' then
                previous := jsonb_build_array(old.semester_display,old.alert_leads);
                current_value := jsonb_build_array(new.semester_display,new.alert_leads);
            when 'background_sessions' then
                previous := old.snapshot - 'notices' - 'fetchedAt';
                current_value := new.snapshot - 'notices' - 'fetchedAt';
            when 'calendar_archives' then
                previous := old.school_data - 'fetchedAt';
                current_value := new.school_data - 'fetchedAt';
            when 'notification_devices' then
                previous := jsonb_build_array(old.session_hash,old.kind,old.destination,old.seat_leads,old.expires_at);
                current_value := jsonb_build_array(new.session_hash,new.kind,new.destination,new.seat_leads,new.expires_at);
            when 'auth_sessions' then
                previous := jsonb_build_array(old.revoked_at,old.expires_at);
                current_value := jsonb_build_array(new.revoked_at,new.expires_at);
            else
                previous := previous - 'updated_at' - 'created_at';
                current_value := current_value - 'updated_at' - 'created_at';
        end case;
        if current_value is not distinct from previous then return null; end if;
    end if;
    insert into reminder_schedule(user_id) values(uid)
    on conflict(user_id) do update set revision=reminder_schedule.revision+1,next_check_at=now();
    perform pg_notify('hongsi_reminders','');
    return null;
end $$;

create trigger reminder_preferences after insert or update or delete on account_preferences for each row execute function queue_reminder_schedule();
create trigger reminder_todos after insert or update or delete on todos for each row execute function queue_reminder_schedule();
create trigger reminder_checks after insert or update or delete on item_checks for each row execute function queue_reminder_schedule();
create trigger reminder_alerts after insert or update or delete on item_alerts_off for each row execute function queue_reminder_schedule();
create trigger reminder_leads after insert or update or delete on item_alert_leads for each row execute function queue_reminder_schedule();
create trigger reminder_seats after insert or update or delete on seat_sessions for each row execute function queue_reminder_schedule();
create trigger reminder_archive after insert or update or delete on calendar_archives for each row execute function queue_reminder_schedule();
create trigger reminder_background after insert or update on background_sessions for each row execute function queue_reminder_schedule();
create trigger reminder_device after insert or update or delete on background_devices for each row execute function queue_reminder_schedule();
create trigger reminder_push after insert or update or delete on notification_devices for each row execute function queue_reminder_schedule();
create trigger reminder_auth after update on auth_sessions for each row execute function queue_reminder_schedule();
