LC_ALL=C
export LC_ALL
disk_options=

# One newline requests one sample. Closing SSH stdin ends the loop even when
# the machine is idle and there would be no subsequent stdout to break a pipe.
while IFS= read -r sample; do
    if ! [ -r /proc/stat ] || ! [ -r /proc/loadavg ] || ! [ -r /proc/meminfo ] ||
       ! [ -r /proc/net/dev ] || ! [ -r /proc/uptime ]; then
        printf 'unsupported\nend\n'
        exit
    fi

    printf 'snapshot\n'
    awk '
        FILENAME == "/proc/stat" && $1 == "cpu" {
            print "cpu", $2, $3, $4, $5, $6, $7, $8, $9
        }
        FILENAME == "/proc/stat" && $1 ~ /^cpu[0-9]+$/ { cores++ }
        FILENAME == "/proc/loadavg" { print "load", $1, $2, $3 }
        FILENAME == "/proc/uptime" { print "uptime", $1 }
        FILENAME == "/proc/meminfo" && $1 == "MemTotal:" { memory = $2 }
        FILENAME == "/proc/meminfo" && $1 == "MemAvailable:" { available = $2 }
        FILENAME == "/proc/meminfo" && $1 == "MemFree:" { free = $2 }
        FILENAME == "/proc/meminfo" && $1 == "SwapTotal:" { swap = $2 }
        FILENAME == "/proc/meminfo" && $1 == "SwapFree:" { swap_free = $2 }
        FILENAME == "/proc/net/dev" && FNR > 2 && interfaces < 512 {
            split($0, row, ":")
            sub(/^[[:space:]]+/, "", row[1])
            sub(/^[[:space:]]+/, "", row[2])
            split(row[2], counters, /[[:space:]]+/)
            if (row[1] != "lo" && row[1] != "") {
                print "net", row[1], counters[1], counters[9]
                interfaces++
            }
        }
        END {
            print "cores", cores + 0
            print "memory", memory, (available == "" ? free : available)
            print "swap", swap, swap_free
        }
    ' /proc/stat /proc/loadavg /proc/meminfo /proc/net/dev /proc/uptime || exit 1

    # /proc describes mount points but does not report filesystem space.
    # Prefer local mounts when df has -l. BusyBox supports the POSIX flags.
    if [ -z "$disk_options" ]; then
        disk_options=-kP
        if df -kPl / >/dev/null 2>&1; then disk_options=-kPl; fi
    fi
    df "$disk_options" 2>/dev/null | awk '
        NR > 1 && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ && mounts < 5 {
            mount = $0
            for (i = 0; i < 5; i++)
                sub(/^[[:space:]]*[^[:space:]]+[[:space:]]+/, "", mount)
            if (substr(mount, 1, 1) == "/" && mount !~ /[[:cntrl:]]/ && !seen[mount]++) {
                print "disk", $2, $3, mount
                mounts++
            }
        }
    '
    printf 'end\n'
done
